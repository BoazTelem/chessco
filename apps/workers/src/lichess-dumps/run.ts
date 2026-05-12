/**
 * Lichess monthly-dump ingest worker — CLI entry point.
 *
 * Usage:
 *   pnpm --filter @chessco/workers lichess:dump 2013-01
 *   pnpm --filter @chessco/workers lichess:dump 2024-01 --max-games 10000
 *   pnpm --filter @chessco/workers lichess:dump 2024-01 --dry-run
 *
 * --dry-run streams + parses + filters but does NOT write to Cloud SQL.
 * Use for parser shakedown on a real dump before committing to ingest.
 */
import 'dotenv/config';
import { getGamesDb } from '../db';
import { BATCH, dumpUrl } from './config';
import { downloadAndOpenDumpStream } from './download';
import { emptyFilterStats, shouldIngest } from './filter';
import { ingestBatch } from './ingest';
import { processGame } from './parse-game';
import { streamGames } from './pgn-stream';
import { finishRun, startRun, tickRun } from './resume';
import type { ProcessedGame } from './parse-game';

interface CliArgs {
  dumpId: string;
  maxGames: number | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  if (argv.length < 1 || !/^\d{4}-\d{2}$/.test(argv[0]!)) {
    throw new Error('Usage: lichess:dump <YYYY-MM> [--max-games N] [--dry-run]');
  }
  const dumpId = argv[0]!;
  let maxGames: number | null = null;
  let dryRun = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max-games' && argv[i + 1]) {
      maxGames = Number.parseInt(argv[++i]!, 10);
    } else if (a === '--dry-run') {
      dryRun = true;
    } else {
      throw new Error(`Unrecognized arg: ${a}`);
    }
  }
  return { dumpId, maxGames, dryRun };
}

function fmt(n: number): string {
  return n.toLocaleString();
}
function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = dumpUrl(args.dumpId);

  console.log(`[lichess-dumps] dump=${args.dumpId} url=${url}`);
  console.log(`[lichess-dumps] max-games=${args.maxGames ?? '∞'} dry-run=${args.dryRun}`);

  const dump = await downloadAndOpenDumpStream(url, args.dumpId);
  console.log(
    `[lichess-dumps] connected. total_bytes=${dump.totalBytes ? fmtBytes(dump.totalBytes) : 'unknown'}`,
  );

  const { client } = args.dryRun ? { client: null } : getGamesDb();
  if (client) await startRun(client, args.dumpId, url, dump.totalBytes);

  const stats = emptyFilterStats();
  const buffer: ProcessedGame[] = [];
  let positionsTotal = 0;
  let movesTotal = 0;
  let lastTickBytes = 0;
  const startedAt = Date.now();

  const flush = async () => {
    if (buffer.length === 0) return;
    if (client) {
      const r = await ingestBatch(client, buffer);
      positionsTotal += r.positions_inserted;
      movesTotal += r.moves;
    } else {
      // Dry run accounting.
      for (const g of buffer) {
        positionsTotal += g.positions.length;
        movesTotal += g.moves.length;
      }
    }
    buffer.length = 0;
  };

  try {
    for await (const game of streamGames(dump.text)) {
      if (!shouldIngest(game.headers, stats)) continue;
      const out = processGame(game);
      if (!out) continue;
      buffer.push(out);

      if (buffer.length >= BATCH.gamesPerBatch) {
        await flush();
      }

      // Progress tick — every ~50 MB compressed read.
      const bytes = dump.getCompressedBytesRead();
      if (bytes - lastTickBytes >= BATCH.progressByteInterval) {
        lastTickBytes = bytes;
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = stats.seen / elapsed;
        const pct = dump.totalBytes ? ((bytes / dump.totalBytes) * 100).toFixed(1) + '%' : '?';
        console.log(
          `  · ${fmtBytes(bytes)}/${dump.totalBytes ? fmtBytes(dump.totalBytes) : '?'} (${pct})  ` +
            `seen=${fmt(stats.seen)}  accepted=${fmt(stats.accepted)}  ` +
            `${rate.toFixed(0)} games/s  ` +
            `positions=${fmt(positionsTotal)}  moves=${fmt(movesTotal)}`,
        );
        if (client) {
          await tickRun(client, args.dumpId, {
            bytes_downloaded: bytes,
            games_seen: stats.seen,
            games_filtered_in: stats.accepted,
            positions_inserted: positionsTotal,
            moves_inserted: movesTotal,
          });
        }
      }

      if (args.maxGames !== null && stats.accepted >= args.maxGames) {
        console.log(`[lichess-dumps] hit --max-games ${args.maxGames}, stopping.`);
        break;
      }
    }
    await flush();

    if (client) {
      await tickRun(client, args.dumpId, {
        bytes_downloaded: dump.getCompressedBytesRead(),
        games_seen: stats.seen,
        games_filtered_in: stats.accepted,
        positions_inserted: positionsTotal,
        moves_inserted: movesTotal,
      });
      await finishRun(client, args.dumpId, 'done');
    }

    const elapsed = (Date.now() - startedAt) / 1000;
    console.log('\n[lichess-dumps] DONE');
    console.log('  filter stats:', stats);
    console.log(
      `  positions=${fmt(positionsTotal)}  moves=${fmt(movesTotal)}  ` +
        `elapsed=${elapsed.toFixed(0)}s  avg=${(stats.seen / elapsed).toFixed(0)} games/s`,
    );
  } catch (err) {
    if (client) {
      await finishRun(
        client,
        args.dumpId,
        'failed',
        err instanceof Error ? err.message : String(err),
      );
    }
    throw err;
  } finally {
    if (client) await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('lichess-dump worker failed:', err);
  process.exit(1);
});
