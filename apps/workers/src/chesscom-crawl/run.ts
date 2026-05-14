/**
 * chess.com priority-queue crawler — CLI entry point.
 *
 * Reads chesscom_crawl_queue rows one at a time, dispatches by kind:
 *   - archives_list: fetch /pub/player/{u}/games/archives, expand into
 *                    archive_month rows (most recent N months).
 *   - archive_month: fetch the monthly PGN bundle, filter, parse, ingest.
 *
 * Crash-resumable: stale in_progress claims (> 10 min old) are reset on
 * boot. Failed items get exponential backoff (1m → 5m → 30m → 4h → 24h)
 * up to 5 attempts; the 6th puts them into error_permanent.
 *
 * Usage:
 *   pnpm --filter @chessco/workers chesscom:crawl
 *   pnpm --filter @chessco/workers chesscom:crawl --max-items 100
 *   pnpm --filter @chessco/workers chesscom:crawl --rate-ms 2000 --months-back 12
 *   pnpm --filter @chessco/workers chesscom:crawl --idle-sleep-sec 60
 *   pnpm --filter @chessco/workers chesscom:crawl --no-opponent-expand
 */
import 'dotenv/config';
import { hostname } from 'node:os';
import type postgres from 'postgres';
import { getGamesDb } from '../db';
import {
  ChesscomApiError,
  fetchArchiveMonth,
  fetchArchivesList,
  type ChesscomArchiveGame,
} from '../lib/chesscom-api';
import { ingestBatch } from '../lichess-dumps/ingest';
import type { ProcessedGame } from '../lichess-dumps/parse-game';
import { enqueueOpponents } from './discover-opponents';
import { emptyChesscomFilterStats, shouldIngestChesscom } from './filter';
import { processChesscomGame } from './parse-game';
import {
  claimNext,
  completeItem,
  expandArchivesList,
  failItem,
  finishRun,
  queueProgress,
  recoverStaleClaims,
  startRun,
  tickRun,
  type QueueRow,
} from './queue';

interface CliArgs {
  maxItems: number | null;
  rateMs: number;
  monthsBack: number;
  idleSleepSec: number;
  workerId: string;
  exitWhenEmpty: boolean;
  noOpponentExpand: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    maxItems: null,
    rateMs: 2000,
    monthsBack: 12,
    idleSleepSec: 60,
    workerId: `${hostname()}-${process.pid}`,
    exitWhenEmpty: false,
    noOpponentExpand: false,
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
    else if (a === '--no-opponent-expand') args.noOpponentExpand = true;
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
    `[chesscom-crawl] worker=${args.workerId} rate=${args.rateMs}ms ` +
      `months_back=${args.monthsBack} max_items=${args.maxItems ?? '∞'} ` +
      `opponent_expand=${args.noOpponentExpand ? 'off' : 'on'}`,
  );

  const { client } = getGamesDb();
  let shouldStop = false;

  const onSignal = (sig: string) => {
    console.log(`\n[chesscom-crawl] received ${sig} — finishing current item then exiting…`);
    shouldStop = true;
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  const recovered = await recoverStaleClaims(client);
  if (recovered > 0) {
    console.log(`[chesscom-crawl] recovered ${recovered} stale claim(s) from previous run`);
  }

  const runId = await startRun(client, args.workerId);
  console.log(`[chesscom-crawl] run_id=${runId}`);

  const sessionStats = {
    items: 0,
    games: 0,
    errors: 0,
    archivesListsExpanded: 0,
    archiveMonthsIngested: 0,
  };

  const filterStats = emptyChesscomFilterStats();

  try {
    while (!shouldStop) {
      if (args.maxItems !== null && sessionStats.items >= args.maxItems) {
        console.log(`[chesscom-crawl] hit --max-items ${args.maxItems}, stopping.`);
        break;
      }

      const iterStart = Date.now();

      const claimed = await claimNext(client, 1);
      if (claimed.length === 0) {
        // Queue idle. Report progress, then either exit or sleep.
        const progress = await queueProgress(client);
        const totalRemaining = progress.pending + progress.error_retry;
        console.log(
          `[chesscom-crawl] queue idle: pending=${fmt(progress.pending)} ` +
            `error_retry=${fmt(progress.error_retry)} done=${fmt(progress.done)} ` +
            `permanent=${fmt(progress.error_permanent)}`,
        );
        if (totalRemaining === 0 || args.exitWhenEmpty) {
          console.log('[chesscom-crawl] no more work, exiting.');
          break;
        }
        // Backoff-aware sleep: items in error_retry may have future
        // next_attempt_at, so we sleep before trying again.
        await sleepInterruptibly(args.idleSleepSec * 1000, () => shouldStop);
        continue;
      }

      const item = claimed[0]!;
      try {
        if (item.kind === 'archives_list') {
          const inserted = await handleArchivesList(client, item, args.monthsBack);
          sessionStats.archivesListsExpanded++;
          console.log(`  · ${item.handle}: archives_list → ${fmt(inserted)} months queued`);
        } else {
          const gamesInserted = await handleArchiveMonth(
            client,
            item,
            filterStats,
            !args.noOpponentExpand,
          );
          sessionStats.archiveMonthsIngested++;
          sessionStats.games += gamesInserted;
          if (gamesInserted > 0 || filterStats.seen % 1000 === 0) {
            console.log(
              `  · ${item.handle} ${item.archive_year}-${String(item.archive_month).padStart(2, '0')}: ` +
                `${fmt(gamesInserted)} games ingested ` +
                `(seen=${fmt(filterStats.seen)} accepted=${fmt(filterStats.accepted)})`,
            );
          }
        }
        sessionStats.items++;
      } catch (err) {
        sessionStats.errors++;
        const msg = err instanceof Error ? err.message : String(err);
        const outcome = await failItem(client, item.id, item.attempts, msg);
        console.warn(
          `  ! ${item.kind} ${item.handle}${item.archive_url ? ' ' + item.archive_url : ''} ` +
            `attempt ${item.attempts}/5 → ${outcome}: ${msg}`,
        );
      }

      // Heartbeat every 10 items (avoid hammering with single-row updates
      // when each item already does 1-2 inserts).
      if (sessionStats.items % 10 === 0) {
        await tickRun(client, runId, {
          items: 10,
          games: sessionStats.games,
          errors: sessionStats.errors,
        });
        sessionStats.games = 0;
        sessionStats.errors = 0;
      }

      // Outer rate-limit gap. The inner chesscom-api client also self-throttles
      // at 100ms; this sits on top to keep us at the queue's overall pacing.
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
    console.log('\n[chesscom-crawl] session summary:');
    console.log(`  items processed: ${fmt(sessionStats.items)}`);
    console.log(`  archives_list expanded: ${fmt(sessionStats.archivesListsExpanded)}`);
    console.log(`  archive_month ingested: ${fmt(sessionStats.archiveMonthsIngested)}`);
    console.log(`  filter stats:`, filterStats);
  } catch (err) {
    await finishRun(client, runId, 'failed', err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function handleArchivesList(
  sql: postgres.Sql,
  item: QueueRow,
  monthsBack: number,
): Promise<number> {
  const urls = await fetchArchivesList(item.handle);
  const inserted = await expandArchivesList(
    sql,
    item.id,
    item.handle,
    urls,
    item.priority,
    monthsBack,
  );
  return inserted;
}

async function handleArchiveMonth(
  sql: postgres.Sql,
  item: QueueRow,
  filterStats: ReturnType<typeof emptyChesscomFilterStats>,
  expandOpponents: boolean,
): Promise<number> {
  if (!item.archive_url) {
    throw new Error('archive_month row missing archive_url');
  }
  let games: ChesscomArchiveGame[];
  try {
    games = await fetchArchiveMonth(item.archive_url);
  } catch (err) {
    if (err instanceof ChesscomApiError && err.status === 404) {
      // Archive URL listed but month has no games — treat as done.
      await completeItem(sql, item.id, 0);
      return 0;
    }
    throw err;
  }

  const buffer: ProcessedGame[] = [];
  for (const g of games) {
    if (!shouldIngestChesscom(g, filterStats)) continue;
    const processed = processChesscomGame(g);
    if (processed) buffer.push(processed);
  }

  let gamesInserted = 0;
  if (buffer.length > 0) {
    const result = await ingestBatch(sql, buffer);
    gamesInserted = result.games;
    if (expandOpponents) {
      // Transitive discovery: enqueue this archive's opponents as new
      // archives_list rows so the crawler eventually fetches their games
      // too. Idempotent — ON CONFLICT handles already-known handles.
      await enqueueOpponents(sql, buffer, item.handle);
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
  console.error('chesscom-crawl worker failed:', err);
  process.exit(1);
});
