/**
 * Parallel Stockfish backfill — analyze unanalyzed games in `games` and
 * write per-game cp-loss aggregates back into the row.
 *
 * Concurrency: N child Stockfish processes coordinated from one Node host.
 * Each worker pulls from a shared queue and runs analyzeGame independently;
 * results stream back to a single Postgres writer that does small batched
 * UPDATEs.
 *
 *   pnpm --filter @chessco/workers exec tsx \
 *     src/stockfish/backfill.ts --workers 4 --depth 10 --batch 200
 *
 * Flags:
 *   --workers N    parallel Stockfish engines (default 4)
 *   --depth D      Stockfish search depth per position (default 10)
 *   --batch B      games per chunk pulled from DB (default 200)
 *   --limit L      stop after L games analyzed (default ∞)
 *   --source S     only analyze 'lichess' | 'chess.com' games (default: both)
 */
import 'dotenv/config';
import type postgres from 'postgres';
import { getGamesDb } from '../db';
import { analyzeGame } from '../lib/analyze-game';
import { StockfishEngine } from '../lib/stockfish';

interface CliArgs {
  workers: number;
  depth: number;
  batch: number;
  limit: number;
  source: 'lichess' | 'chess.com' | null;
}

function parseArgs(argv: string[]): CliArgs {
  let workers = 4;
  let depth = 10;
  let batch = 200;
  let limit = Number.POSITIVE_INFINITY;
  let source: CliArgs['source'] = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workers' && argv[i + 1]) workers = parseInt(argv[++i]!, 10);
    else if (a === '--depth' && argv[i + 1]) depth = parseInt(argv[++i]!, 10);
    else if (a === '--batch' && argv[i + 1]) batch = parseInt(argv[++i]!, 10);
    else if (a === '--limit' && argv[i + 1]) limit = parseInt(argv[++i]!, 10);
    else if (a === '--source' && argv[i + 1]) source = argv[++i]! as 'lichess' | 'chess.com';
    else throw new Error(`unknown arg: ${a}`);
  }
  return { workers, depth, batch, limit, source };
}

interface UnanalyzedRow {
  id: string;
  played_at: string;
  pgn: string;
  ply_count: number;
}

interface AnalysisResult {
  id: string;
  played_at: string;
  mean_cp_loss: number | null;
  mean_cp_loss_white: number | null;
  mean_cp_loss_black: number | null;
  blunder_count: number;
  plies_analyzed: number;
}

async function pullChunk(
  client: postgres.Sql,
  args: CliArgs,
  remaining: number,
): Promise<UnanalyzedRow[]> {
  const size = Math.min(args.batch, remaining);
  if (args.source) {
    return client<UnanalyzedRow[]>`
      SELECT id, played_at::text, pgn, ply_count
      FROM games
      WHERE analyzed_at IS NULL
        AND length(pgn) > 0
        AND source = ${args.source}
      ORDER BY played_at
      LIMIT ${size}
    `;
  }
  return client<UnanalyzedRow[]>`
    SELECT id, played_at::text, pgn, ply_count
    FROM games
    WHERE analyzed_at IS NULL
      AND length(pgn) > 0
    ORDER BY played_at
    LIMIT ${size}
  `;
}

async function flushResults(client: postgres.Sql, results: AnalysisResult[]): Promise<number> {
  if (results.length === 0) return 0;
  // Single round-trip UPDATE FROM (VALUES ...) keyed by composite (id, played_at)
  // because `games` is partitioned and the PK includes played_at.
  const json = JSON.stringify(results);
  const updated = await client<{ id: string }[]>`
    UPDATE games AS g
    SET mean_cp_loss       = (v.r->>'mean_cp_loss')::numeric,
        mean_cp_loss_white = (v.r->>'mean_cp_loss_white')::numeric,
        mean_cp_loss_black = (v.r->>'mean_cp_loss_black')::numeric,
        blunder_count      = (v.r->>'blunder_count')::int,
        plies_analyzed     = (v.r->>'plies_analyzed')::int,
        analyzed_at        = NOW()
    FROM (
      SELECT (val)::jsonb AS r
      FROM jsonb_array_elements(${json}::jsonb) val
    ) v
    WHERE g.id = (v.r->>'id')::uuid
      AND g.played_at = (v.r->>'played_at')::timestamptz
    RETURNING g.id
  `;
  return updated.length;
}

interface WorkerState {
  engine: StockfishEngine;
  idx: number;
}

async function workerLoop(
  state: WorkerState,
  queue: UnanalyzedRow[],
  depth: number,
  onResult: (r: AnalysisResult) => void,
  onSkip: (id: string, reason: string) => void,
): Promise<void> {
  while (true) {
    const game = queue.shift();
    if (!game) return;
    try {
      const a = await analyzeGame(state.engine, game.pgn, { depth });
      if (a.plies_analyzed === 0) {
        // Mark as analyzed-with-null so we don't keep retrying. The page-
        // level UPDATE writes NULL aggregates which means "tried, no signal."
        onResult({
          id: game.id,
          played_at: game.played_at,
          mean_cp_loss: null,
          mean_cp_loss_white: null,
          mean_cp_loss_black: null,
          blunder_count: 0,
          plies_analyzed: 0,
        });
        continue;
      }
      onResult({
        id: game.id,
        played_at: game.played_at,
        mean_cp_loss: a.mean_cp_loss,
        mean_cp_loss_white: a.mean_cp_loss_white,
        mean_cp_loss_black: a.mean_cp_loss_black,
        blunder_count: a.blunder_count,
        plies_analyzed: a.plies_analyzed,
      });
    } catch (e) {
      onSkip(game.id, (e as Error).message);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[backfill-cp] workers=${args.workers} depth=${args.depth} batch=${args.batch} limit=${args.limit === Infinity ? '∞' : args.limit} source=${args.source ?? '(all)'}`,
  );

  const { client } = getGamesDb();
  let totalAnalyzed = 0;
  let totalSkipped = 0;
  let totalUpdated = 0;
  const startedAt = Date.now();

  console.log(`[backfill-cp] spawning ${args.workers} stockfish engines…`);
  const engines: WorkerState[] = [];
  for (let i = 0; i < args.workers; i++) {
    engines.push({ engine: await StockfishEngine.start('lite-single'), idx: i });
  }
  console.log(`[backfill-cp] engines ready.`);

  try {
    while (totalAnalyzed < args.limit) {
      const remaining = args.limit - totalAnalyzed;
      const chunk = await pullChunk(client, args, remaining);
      if (chunk.length === 0) {
        console.log(`[backfill-cp] no more unanalyzed games — done.`);
        break;
      }
      const chunkStart = Date.now();

      const queue = [...chunk];
      const results: AnalysisResult[] = [];
      const skipped: Array<{ id: string; reason: string }> = [];

      await Promise.all(
        engines.map((w) =>
          workerLoop(
            w,
            queue,
            args.depth,
            (r) => results.push(r),
            (id, reason) => skipped.push({ id, reason }),
          ),
        ),
      );

      const written = await flushResults(client, results);
      totalAnalyzed += results.length;
      totalSkipped += skipped.length;
      totalUpdated += written;

      const dt = (Date.now() - chunkStart) / 1000;
      const elapsedMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
      const rate = results.length / dt;
      console.log(
        `[backfill-cp] chunk: ${results.length} analyzed (${written} written, ${skipped.length} skip) in ${dt.toFixed(1)}s @ ${rate.toFixed(1)}/s — total ${totalAnalyzed.toLocaleString()} after ${elapsedMin}min`,
      );
      if (skipped.length > 0 && skipped.length <= 3) {
        for (const s of skipped)
          console.log(`    [skip ${s.id.slice(0, 8)}] ${s.reason.slice(0, 100)}`);
      }
    }
  } finally {
    console.log(`[backfill-cp] shutting down engines…`);
    for (const w of engines) await w.engine.quit().catch(() => undefined);
    await client.end({ timeout: 5 });
  }

  const totalMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
  console.log(`\n[backfill-cp] DONE`);
  console.log(`  analyzed   = ${totalAnalyzed.toLocaleString()}`);
  console.log(`  skipped    = ${totalSkipped.toLocaleString()}`);
  console.log(`  db updates = ${totalUpdated.toLocaleString()}`);
  console.log(`  elapsed    = ${totalMin} min`);
}

main().catch((err) => {
  console.error('[backfill-cp] failed:', err);
  process.exit(1);
});
