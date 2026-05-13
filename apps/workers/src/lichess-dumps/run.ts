/**
 * Lichess monthly-dump ingest worker — CLI entry point.
 *
 * Usage:
 *   pnpm --filter @chessco/workers lichess:dump 2013-01
 *   pnpm --filter @chessco/workers lichess:dump 2024-01 --max-games 10000
 *   pnpm --filter @chessco/workers lichess:dump 2024-01 --dry-run
 *   pnpm --filter @chessco/workers lichess:dump 2026-04 --scan-handles-only
 *
 * --dry-run streams + parses + filters but does NOT write to Cloud SQL.
 *   Use for parser shakedown on a real dump before committing to ingest.
 *
 * --scan-handles-only does NOT do full ingest; it parses headers only,
 *   aggregates (handle, max_rating, last_seen, games_seen), and bulk-
 *   upserts into lichess_crawl_queue for the per-handle crawler. ~10x
 *   faster than full ingest. Use for one-off seed expansion.
 */
import 'dotenv/config';
import type postgres from 'postgres';
import { getGamesDb } from '../db';
import { BATCH, dumpUrl } from './config';
import { downloadAndOpenDumpStream, type DumpStream } from './download';
import { scanHandlesFromDump, flushHandlesToQueue } from './extract-handles';
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
  /** Header-only scan: extract handles+ratings, skip full ingest. Seeds
   *  lichess_crawl_queue for the per-handle crawler. ~10x faster than
   *  full ingest (bandwidth-bound, not CPU-bound). */
  scanHandlesOnly: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  if (argv.length < 1 || !/^\d{4}-\d{2}$/.test(argv[0]!)) {
    throw new Error(
      'Usage: lichess:dump <YYYY-MM> [--max-games N] [--dry-run] [--scan-handles-only]',
    );
  }
  const dumpId = argv[0]!;
  let maxGames: number | null = null;
  let dryRun = false;
  let scanHandlesOnly = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max-games' && argv[i + 1]) {
      maxGames = Number.parseInt(argv[++i]!, 10);
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--scan-handles-only') {
      scanHandlesOnly = true;
    } else {
      throw new Error(`Unrecognized arg: ${a}`);
    }
  }
  return { dumpId, maxGames, dryRun, scanHandlesOnly };
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
  console.log(
    `[lichess-dumps] max-games=${args.maxGames ?? '∞'} dry-run=${args.dryRun} ` +
      `scan-handles-only=${args.scanHandlesOnly}`,
  );

  const dump = await downloadAndOpenDumpStream(url, args.dumpId);
  console.log(
    `[lichess-dumps] connected. total_bytes=${dump.totalBytes ? fmtBytes(dump.totalBytes) : 'unknown'}`,
  );

  // Header-only scan mode: skip the full ingest pipeline entirely. Used
  // to seed lichess_crawl_queue with hundreds of thousands of handles for
  // the per-handle API crawler to drain.
  if (args.scanHandlesOnly) {
    await runScanHandlesOnly(dump, args);
    return;
  }

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

/**
 * Header-only scan path. Aggregates handles+ratings from PGN headers
 * (no chess.js, no positions, no moves, no games table writes) and
 * bulk-seeds lichess_crawl_queue at the end.
 */
async function runScanHandlesOnly(
  dump: DumpStream,
  args: { dumpId: string; maxGames: number | null; dryRun: boolean },
): Promise<void> {
  const startedAt = Date.now();
  const { client } = args.dryRun ? { client: null as postgres.Sql | null } : getGamesDb();
  try {
    const result = await scanHandlesFromDump(
      dump,
      {
        maxGames: args.maxGames,
        progressByteInterval: BATCH.progressByteInterval,
      },
      (s) => {
        const pct = dump.totalBytes
          ? ((s.bytesRead / dump.totalBytes) * 100).toFixed(1) + '%'
          : '?';
        console.log(
          `  · ${fmtBytes(s.bytesRead)}/${dump.totalBytes ? fmtBytes(dump.totalBytes) : '?'} ` +
            `(${pct})  seen=${fmt(s.gamesSeen)}  accepted=${fmt(s.gamesAccepted)}  ` +
            `handles=${fmt(s.handles)}`,
        );
      },
    );

    console.log('\n[lichess-dumps:scan] STREAM DONE');
    console.log('  filter stats:', result.filter);
    console.log(
      `  distinct handles: ${fmt(result.handles.size)}  ` +
        `elapsed=${result.elapsedSec.toFixed(0)}s  ` +
        `avg=${(result.filter.seen / result.elapsedSec).toFixed(0)} games/s`,
    );

    if (!client) {
      console.log('[lichess-dumps:scan] dry-run — skipping queue upsert.');
      return;
    }

    console.log(`[lichess-dumps:scan] flushing ${fmt(result.handles.size)} handles to queue…`);
    const flush = await flushHandlesToQueue(client, result.handles);
    console.log(
      `[lichess-dumps:scan] queue: inserted=${fmt(flush.inserted)} ` +
        `updated=${fmt(flush.updated)} (priority bumped if higher max-elo seen)`,
    );
    console.log(`[lichess-dumps:scan] DONE in ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
  } finally {
    if (client) await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('lichess-dump worker failed:', err);
  process.exit(1);
});
