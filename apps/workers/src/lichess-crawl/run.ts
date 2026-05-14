/**
 * Lichess per-handle crawler — CLI entry point.
 *
 * For each pending queue row:
 *   1. Compute (since, until) from --months-back (default 12).
 *   2. Stream PGN from /api/games/user/{handle}?since=...&until=....
 *   3. Iterate via streamGames; apply the dump filter (rated standard,
 *      both Elos >= 1500, has a result); process each survivor with
 *      the dump parser into ProcessedGame.
 *   4. Flush every BATCH.gamesPerBatch games through ingestBatch.
 *   5. completeItem on success, failItem with backoff on error.
 *
 * Crash-resumable: stale in_progress claims (> 10 min old) are reset
 * on boot. Failed items get exponential backoff (1m → 5m → 30m → 4h →
 * 24h) up to 5 attempts; the 6th puts them into error_permanent.
 *
 * Usage:
 *   pnpm --filter @chessco/workers lichess:crawl
 *   pnpm --filter @chessco/workers lichess:crawl --max-items 10
 *   pnpm --filter @chessco/workers lichess:crawl --rate-ms 2000 --months-back 12
 */
import 'dotenv/config';
import { hostname } from 'node:os';
import type postgres from 'postgres';
import { getGamesDb } from '../db';
import { LichessApiError, fetchUserGamesPgn } from '../lib/lichess-api';
import { BATCH } from '../lichess-dumps/config';
import { ingestBatch } from '../lichess-dumps/ingest';
import { processGame } from '../lichess-dumps/parse-game';
import type { ProcessedGame } from '../lichess-dumps/parse-game';
import { streamGames } from '../lichess-dumps/pgn-stream';
import { enqueueLichessOpponents } from './discover-opponents';
import { emptyCrawlFilterStats, shouldIngestLichessCrawl } from './filter';
import {
  claimNext,
  completeItem,
  failItem,
  finishRun,
  queueProgress,
  recoverStaleClaims,
  startRun,
  tickRun,
  type LichessQueueRow,
} from './queue';

interface CliArgs {
  maxItems: number | null;
  rateMs: number;
  monthsBack: number;
  idleSleepSec: number;
  workerId: string;
  exitWhenEmpty: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    maxItems: null,
    rateMs: 2000,
    monthsBack: 12,
    idleSleepSec: 60,
    workerId: `${hostname()}-${process.pid}`,
    exitWhenEmpty: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max-items' && argv[i + 1]) args.maxItems = Number.parseInt(argv[++i]!, 10);
    else if (a === '--rate-ms' && argv[i + 1]) args.rateMs = Number.parseInt(argv[++i]!, 10);
    else if (a === '--months-back' && argv[i + 1])
      args.monthsBack = Number.parseInt(argv[++i]!, 10);
    else if (a === '--idle-sleep-sec' && argv[i + 1])
      args.idleSleepSec = Number.parseInt(argv[++i]!, 10);
    else if (a === '--worker-id' && argv[i + 1]) args.workerId = argv[++i]!;
    else if (a === '--exit-when-empty') args.exitWhenEmpty = true;
    else throw new Error(`Unrecognized arg: ${a}`);
  }
  return args;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[lichess-crawl] worker=${args.workerId} rate=${args.rateMs}ms ` +
      `months_back=${args.monthsBack} max_items=${args.maxItems ?? '∞'}`,
  );

  const { client } = getGamesDb();
  let shouldStop = false;

  const onSignal = (sig: string) => {
    console.log(`\n[lichess-crawl] received ${sig} — finishing current item then exiting…`);
    shouldStop = true;
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  const recovered = await recoverStaleClaims(client);
  if (recovered > 0) {
    console.log(`[lichess-crawl] recovered ${recovered} stale claim(s) from previous run`);
  }

  const runId = await startRun(client, args.workerId);
  console.log(`[lichess-crawl] run_id=${runId}`);

  const sessionStats = {
    items: 0,
    games: 0,
    errors: 0,
  };

  try {
    while (!shouldStop) {
      if (args.maxItems !== null && sessionStats.items >= args.maxItems) {
        console.log(`[lichess-crawl] hit --max-items ${args.maxItems}, stopping.`);
        break;
      }

      const iterStart = Date.now();

      const claimed = await claimNext(client, 1);
      if (claimed.length === 0) {
        const progress = await queueProgress(client);
        const totalRemaining = progress.pending + progress.error_retry;
        console.log(
          `[lichess-crawl] queue idle: pending=${fmt(progress.pending)} ` +
            `error_retry=${fmt(progress.error_retry)} done=${fmt(progress.done)} ` +
            `permanent=${fmt(progress.error_permanent)}`,
        );
        if (totalRemaining === 0 || args.exitWhenEmpty) {
          console.log('[lichess-crawl] no more work, exiting.');
          break;
        }
        await sleepInterruptibly(args.idleSleepSec * 1000, () => shouldStop);
        continue;
      }

      const item = claimed[0]!;
      try {
        const gamesInserted = await handleUserGames(client, item, args.monthsBack);
        sessionStats.items++;
        sessionStats.games += gamesInserted;
        console.log(
          `  · ${item.handle}: ${fmt(gamesInserted)} games ingested ` +
            `(total games this session: ${fmt(sessionStats.games)})`,
        );
      } catch (err) {
        sessionStats.errors++;
        const msg = err instanceof Error ? err.message : String(err);
        const outcome = await failItem(client, item.id, item.attempts, msg);
        console.warn(`  ! ${item.handle} attempt ${item.attempts}/5 → ${outcome}: ${msg}`);
      }

      if (sessionStats.items % 10 === 0) {
        await tickRun(client, runId, {
          items: 10,
          games: sessionStats.games,
          errors: sessionStats.errors,
        });
        sessionStats.games = 0;
        sessionStats.errors = 0;
      }

      const elapsed = Date.now() - iterStart;
      const wait = args.rateMs - elapsed;
      if (wait > 0) await sleepInterruptibly(wait, () => shouldStop);
    }

    await tickRun(client, runId, {
      items: 0,
      games: sessionStats.games,
      errors: sessionStats.errors,
    });
    await finishRun(client, runId, shouldStop ? 'stopped' : 'done');
    console.log('\n[lichess-crawl] session summary:');
    console.log(`  items processed: ${fmt(sessionStats.items)}`);
  } catch (err) {
    await finishRun(client, runId, 'failed', err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await client.end({ timeout: 5 });
  }
}

/**
 * Number of equal-width sub-windows to split a handle's monthsBack
 * request into. Lichess's user-export server-side time-limits long
 * streams, which used to surface as `terminated` errors on prolific
 * handles (m_t_h, gamboc etc. went error_permanent at 5×retry). Four
 * quarterly requests of ~3 months each are short enough to complete
 * before the server-side limit kicks in.
 */
const REQUEST_CHUNKS = 4;

async function handleUserGames(
  sql: postgres.Sql,
  item: LichessQueueRow,
  monthsBack: number,
): Promise<number> {
  const filterStats = emptyCrawlFilterStats();
  const buffer: ProcessedGame[] = [];
  let gamesInserted = 0;
  const monthsPerChunk = Math.ceil(monthsBack / REQUEST_CHUNKS);
  const now = new Date();

  // Iterate from oldest chunk to most recent. If the FIRST chunk returns
  // a 404 (handle banned/closed), we short-circuit the whole item.
  for (let chunkIdx = REQUEST_CHUNKS - 1; chunkIdx >= 0; chunkIdx--) {
    const untilOffsetMonths = chunkIdx * monthsPerChunk;
    const sinceOffsetMonths = Math.min((chunkIdx + 1) * monthsPerChunk, monthsBack);
    const untilDate = new Date(now);
    untilDate.setMonth(untilDate.getMonth() - untilOffsetMonths);
    const sinceDate = new Date(now);
    sinceDate.setMonth(sinceDate.getMonth() - sinceOffsetMonths);

    let stream;
    try {
      stream = await fetchUserGamesPgn(item.handle, {
        sinceMs: sinceDate.getTime(),
        untilMs: untilDate.getTime(),
      });
    } catch (err) {
      if (err instanceof LichessApiError && err.status === 404) {
        // 404 on any chunk: handle vanished/banned — treat as done with
        // whatever we've ingested so far (could be zero).
        await completeItem(sql, item.id, gamesInserted);
        return gamesInserted;
      }
      throw err;
    }
    if (stream === null) {
      // Same 404 path via the null-return shape.
      await completeItem(sql, item.id, gamesInserted);
      return gamesInserted;
    }

    for await (const game of streamGames(stream)) {
      if (!shouldIngestLichessCrawl(game.headers, filterStats)) continue;
      const processed = processGame(game);
      if (!processed) continue;
      buffer.push(processed);
      if (buffer.length >= BATCH.gamesPerBatch) {
        const r = await ingestBatch(sql, buffer);
        gamesInserted += r.games;
        await enqueueLichessOpponents(sql, buffer, item.handle);
        buffer.length = 0;
      }
    }
    if (buffer.length > 0) {
      const r = await ingestBatch(sql, buffer);
      gamesInserted += r.games;
      await enqueueLichessOpponents(sql, buffer, item.handle);
      buffer.length = 0;
    }
  }

  await completeItem(sql, item.id, gamesInserted);
  return gamesInserted;
}

function sleepInterruptibly(ms: number, shouldStop: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const tickMs = 250;
    let elapsed = 0;
    const handle = setInterval(() => {
      elapsed += tickMs;
      if (elapsed >= ms || shouldStop()) {
        clearInterval(handle);
        resolve();
      }
    }, tickMs);
  });
}

main().catch((err) => {
  console.error('lichess-crawl worker failed:', err);
  process.exit(1);
});
