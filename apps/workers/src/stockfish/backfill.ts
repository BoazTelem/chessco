/**
 * Parallel Stockfish backfill — analyze unanalyzed games in `games` and
 * write per-game cp-loss aggregates back into the row.
 *
 * Two modes:
 *   1. Global (default): analyze all unanalyzed games. Writes only per-game
 *      aggregates onto `games`.
 *   2. Per-handle (--platform + --handle): analyze the N most-recent games
 *      for one opponent, regardless of analyzed_at state. Writes per-game
 *      aggregates AND per-ply rows into `moves` (cp_loss, is_*, eval_*).
 *      This is the on-demand path the Personalized Leaks feature uses.
 *
 * Concurrency: N child Stockfish processes coordinated from one Node host.
 * Each worker pulls from a shared queue and runs analyzeGame independently;
 * results stream back to a single Postgres writer that does small batched
 * UPDATEs.
 *
 *   pnpm --filter @chessco/workers exec tsx \
 *     src/stockfish/backfill.ts --workers 4 --depth 10 --batch 200
 *   pnpm --filter @chessco/workers exec tsx \
 *     src/stockfish/backfill.ts --platform lichess --handle drnykterstein --limit 100 --start-ply 1 --end-ply 60
 *
 * Flags:
 *   --workers N           parallel Stockfish engines (default 4)
 *   --depth D             Stockfish search depth per position (default 10)
 *   --batch B             games per chunk pulled from DB (default 200)
 *   --limit L             stop after L games analyzed (default ∞)
 *   --source S            only analyze 'lichess' | 'chess.com' games (default: both)
 *   --platform P          per-handle mode: 'lichess' | 'chess.com'
 *   --handle H            per-handle mode: handle string (case-insensitive)
 *   --start-ply N         first ply to analyze (default 10; for openings pass 1)
 *   --end-ply N           last ply to analyze, exclusive (default 60)
 *   --shard N/K           process only games where hash(id) % K == (N-1). Lets two
 *                         machines split the corpus without coordination. (Phase 2c)
 *   --scout-ready-only    only analyze games where at least one player is a
 *                         scout-ready handle (the corpus the matcher actually uses).
 *   --coverage            print analyzed-vs-unanalyzed counts by source and exit.
 */
import 'dotenv/config';
import type postgres from 'postgres';
import { getGamesDb } from '../db';
import { analyzeGame, type PerPlyEval } from '../lib/analyze-game';
import { StockfishEngine } from '../lib/stockfish';

export interface CliArgs {
  workers: number;
  depth: number;
  batch: number;
  limit: number;
  source: 'lichess' | 'chess.com' | null;
  platform: 'lichess' | 'chess.com' | null;
  handle: string | null;
  startPly: number;
  endPly: number;
  /** 1-indexed shard number (e.g. 1 of 2). null = no sharding. */
  shardN: number | null;
  /** Total shard count (e.g. 2). null = no sharding. */
  shardK: number | null;
  /** Only analyze games where at least one player is scout-ready. */
  scoutReadyOnly: boolean;
  /** Print coverage stats and exit. */
  coverage: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let workers = 4;
  let depth = 10;
  let batch = 200;
  let limit = Number.POSITIVE_INFINITY;
  let source: CliArgs['source'] = null;
  let platform: CliArgs['platform'] = null;
  let handle: string | null = null;
  let startPly = 10;
  let endPly = 60;
  let shardN: number | null = null;
  let shardK: number | null = null;
  let scoutReadyOnly = false;
  let coverage = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workers' && argv[i + 1]) workers = parseInt(argv[++i]!, 10);
    else if (a === '--depth' && argv[i + 1]) depth = parseInt(argv[++i]!, 10);
    else if (a === '--batch' && argv[i + 1]) batch = parseInt(argv[++i]!, 10);
    else if (a === '--limit' && argv[i + 1]) limit = parseInt(argv[++i]!, 10);
    else if (a === '--source' && argv[i + 1]) source = argv[++i]! as 'lichess' | 'chess.com';
    else if (a === '--platform' && argv[i + 1]) platform = argv[++i]! as 'lichess' | 'chess.com';
    else if (a === '--handle' && argv[i + 1]) handle = argv[++i]!.trim().toLowerCase();
    else if (a === '--start-ply' && argv[i + 1]) startPly = parseInt(argv[++i]!, 10);
    else if (a === '--end-ply' && argv[i + 1]) endPly = parseInt(argv[++i]!, 10);
    else if (a === '--shard' && argv[i + 1]) {
      const raw = argv[++i]!;
      const m = /^(\d+)\/(\d+)$/.exec(raw);
      if (!m) throw new Error(`--shard must be N/K (e.g. 1/2), got: ${raw}`);
      shardN = parseInt(m[1]!, 10);
      shardK = parseInt(m[2]!, 10);
    } else if (a === '--scout-ready-only') scoutReadyOnly = true;
    else if (a === '--coverage') coverage = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  if ((platform === null) !== (handle === null)) {
    throw new Error('--platform and --handle must be given together');
  }
  if (shardN !== null && shardK !== null) {
    if (shardK < 2) throw new Error(`--shard K must be >= 2`);
    if (shardN < 1 || shardN > shardK)
      throw new Error(`--shard N must be in 1..K (got ${shardN}/${shardK})`);
  }
  return {
    workers,
    depth,
    batch,
    limit,
    source,
    platform,
    handle,
    startPly,
    endPly,
    shardN,
    shardK,
    scoutReadyOnly,
    coverage,
  };
}

/** Pretty-print analyzed/unanalyzed game counts by source, then exit. */
async function printCoverage(client: postgres.Sql): Promise<void> {
  const rows = await client<
    { source: string; analyzed: string; unanalyzed: string; total: string }[]
  >`
    SELECT source,
           COUNT(*) FILTER (WHERE analyzed_at IS NOT NULL)::text AS analyzed,
           COUNT(*) FILTER (WHERE analyzed_at IS NULL)::text     AS unanalyzed,
           COUNT(*)::text                                        AS total
    FROM games
    GROUP BY source ORDER BY source
  `;
  console.log('--- Stockfish coverage ---');
  for (const r of rows) {
    const pct = ((Number(r.analyzed) / Number(r.total)) * 100).toFixed(1);
    console.log(
      `  ${r.source.padEnd(12)} analyzed=${r.analyzed.padStart(10)} unanalyzed=${r.unanalyzed.padStart(10)} total=${r.total.padStart(10)}  (${pct}%)`,
    );
  }
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
  per_ply?: PerPlyEval[];
}

async function pullChunk(
  client: postgres.Sql,
  args: CliArgs,
  remaining: number,
  alreadyPulledGameIds: Set<string>,
): Promise<UnanalyzedRow[]> {
  const size = Math.min(args.batch, remaining);
  const shardClause =
    args.shardN !== null && args.shardK !== null
      ? client`AND ABS((('x' || left(md5(g.id::text), 8))::bit(32)::int)::bigint) % ${args.shardK} = ${args.shardN - 1}`
      : client``;
  const scoutReadyClause = args.scoutReadyOnly
    ? client`AND EXISTS (
        SELECT 1
        FROM handles h
        WHERE h.scout_ready_at IS NOT NULL
          AND h.platform = g.source
          AND (
            h.id = g.white_player_id
            OR h.id = g.black_player_id
            OR LOWER(h.handle) = LOWER(g.white_handle_snapshot)
            OR LOWER(h.handle) = LOWER(g.black_handle_snapshot)
          )
      )`
    : client``;

  // Per-handle mode: re-analyze recent games for one opponent regardless of
  // analyzed_at, to populate per-ply moves rows for the leaks feature.
  // Uses *_handle_snapshot (always populated) + UNION ALL to keep the
  // planner on the color-specific snapshot indexes (games-corpus 0012);
  // a single OR on the snapshots falls back to a seqscan.
  if (args.platform !== null && args.handle !== null) {
    const handleLower = args.handle;
    const skipIds = [...alreadyPulledGameIds];
    return client<UnanalyzedRow[]>`
      SELECT id, played_at::text, pgn, ply_count FROM (
        (SELECT g.id, g.played_at, g.pgn, g.ply_count FROM games g
          WHERE g.source = ${args.platform}
            AND length(g.pgn) > 0
            AND LOWER(g.white_handle_snapshot) = ${handleLower}
            AND (${skipIds.length === 0} OR g.id <> ALL (${skipIds}::uuid[]))
            ${shardClause}
            ${scoutReadyClause}
          ORDER BY g.played_at DESC LIMIT ${size})
        UNION ALL
        (SELECT g.id, g.played_at, g.pgn, g.ply_count FROM games g
          WHERE g.source = ${args.platform}
            AND length(g.pgn) > 0
            AND LOWER(g.black_handle_snapshot) = ${handleLower}
            AND (${skipIds.length === 0} OR g.id <> ALL (${skipIds}::uuid[]))
            ${shardClause}
            ${scoutReadyClause}
          ORDER BY g.played_at DESC LIMIT ${size})
      ) x
      ORDER BY played_at DESC LIMIT ${size}
    `;
  }

  if (args.source) {
    return client<UnanalyzedRow[]>`
      SELECT g.id, g.played_at::text, g.pgn, g.ply_count
      FROM games g
      WHERE g.analyzed_at IS NULL
        AND length(g.pgn) > 0
        AND g.source = ${args.source}
        ${shardClause}
        ${scoutReadyClause}
      ORDER BY g.played_at
      LIMIT ${size}
    `;
  }
  return client<UnanalyzedRow[]>`
    SELECT g.id, g.played_at::text, g.pgn, g.ply_count
    FROM games g
    WHERE g.analyzed_at IS NULL
      AND length(g.pgn) > 0
      ${shardClause}
      ${scoutReadyClause}
    ORDER BY g.played_at
    LIMIT ${size}
  `;
}

async function flushResults(client: postgres.Sql, results: AnalysisResult[]): Promise<number> {
  if (results.length === 0) return 0;
  // Strip per_ply for the per-game UPDATE — written separately.
  const gameRows = results.map((r) => ({
    id: r.id,
    played_at: r.played_at,
    mean_cp_loss: r.mean_cp_loss,
    mean_cp_loss_white: r.mean_cp_loss_white,
    mean_cp_loss_black: r.mean_cp_loss_black,
    blunder_count: r.blunder_count,
    plies_analyzed: r.plies_analyzed,
  }));
  const json = JSON.stringify(gameRows);
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

/**
 * Write per-ply eval data to the `moves` table. Used by per-handle mode.
 * `moves.id` is bigserial, so we UPDATE by (game_id, ply) which has an index.
 * Done in chunks via UPDATE FROM (jsonb_array_elements(...)) to keep
 * round-trips small.
 */
async function flushPerPly(client: postgres.Sql, results: AnalysisResult[]): Promise<number> {
  const rows: Array<{
    game_id: string;
    ply: number;
    eval_before_cp: number | null;
    eval_after_cp: number | null;
    eval_before_mate: number | null;
    eval_after_mate: number | null;
    cp_loss: number | null;
    is_inaccuracy: boolean;
    is_mistake: boolean;
    is_blunder: boolean;
  }> = [];
  for (const r of results) {
    if (!r.per_ply || r.per_ply.length === 0) continue;
    for (const p of r.per_ply) {
      rows.push({ game_id: r.id, ...p });
    }
  }
  if (rows.length === 0) return 0;
  const json = JSON.stringify(rows);
  const updated = await client<{ id: number }[]>`
    UPDATE moves AS m
    SET eval_before_cp   = NULLIF(v.r->>'eval_before_cp', '')::int,
        eval_after_cp    = NULLIF(v.r->>'eval_after_cp', '')::int,
        eval_before_mate = NULLIF(v.r->>'eval_before_mate', '')::int,
        eval_after_mate  = NULLIF(v.r->>'eval_after_mate', '')::int,
        cp_loss          = NULLIF(v.r->>'cp_loss', '')::int,
        is_inaccuracy    = (v.r->>'is_inaccuracy')::boolean,
        is_mistake       = (v.r->>'is_mistake')::boolean,
        is_blunder       = (v.r->>'is_blunder')::boolean
    FROM (
      SELECT (val)::jsonb AS r
      FROM jsonb_array_elements(${json}::jsonb) val
    ) v
    WHERE m.game_id = (v.r->>'game_id')::uuid
      AND m.ply = (v.r->>'ply')::int
    RETURNING m.id
  `;
  return updated.length;
}

interface WorkerState {
  engine: StockfishEngine;
  idx: number;
}

interface WorkerOptions {
  depth: number;
  startPly: number;
  endPly: number;
  collectPerPly: boolean;
}

async function workerLoop(
  state: WorkerState,
  queue: UnanalyzedRow[],
  opts: WorkerOptions,
  onResult: (r: AnalysisResult) => void,
  onSkip: (id: string, reason: string) => void,
): Promise<void> {
  while (true) {
    const game = queue.shift();
    if (!game) return;
    try {
      const a = await analyzeGame(state.engine, game.pgn, {
        depth: opts.depth,
        startPly: opts.startPly,
        endPly: opts.endPly,
        collectPerPly: opts.collectPerPly,
      });
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
        per_ply: a.per_ply,
      });
    } catch (e) {
      onSkip(game.id, (e as Error).message);
    }
  }
}

export interface BackfillStats {
  totalAnalyzed: number;
  totalSkipped: number;
  gameUpdates: number;
  moveUpdates: number;
  elapsedSec: number;
}

export async function runBackfill(args: CliArgs): Promise<BackfillStats> {
  const perHandle = args.platform !== null && args.handle !== null;
  const shardLabel =
    args.shardN !== null && args.shardK !== null ? ` shard=${args.shardN}/${args.shardK}` : '';
  const scoutLabel = args.scoutReadyOnly ? ' scout-ready-only=on' : '';
  console.log(
    `[backfill-cp] workers=${args.workers} depth=${args.depth} batch=${args.batch} limit=${args.limit === Infinity ? '∞' : args.limit} source=${args.source ?? '(all)'}${shardLabel}${scoutLabel}${perHandle ? ` per-handle=${args.platform}/${args.handle} plies=${args.startPly}..${args.endPly} per-ply-writes=on` : ''}`,
  );

  const { client } = getGamesDb();
  if (args.coverage) {
    const startedAt = Date.now();
    try {
      await printCoverage(client);
      return {
        totalAnalyzed: 0,
        totalSkipped: 0,
        gameUpdates: 0,
        moveUpdates: 0,
        elapsedSec: (Date.now() - startedAt) / 1000,
      };
    } finally {
      await client.end({ timeout: 5 });
    }
  }

  let totalAnalyzed = 0;
  let totalSkipped = 0;
  let totalUpdated = 0;
  let totalMovesUpdated = 0;
  const startedAt = Date.now();
  const pulled = new Set<string>();

  console.log(`[backfill-cp] spawning ${args.workers} stockfish engines…`);
  const engines: WorkerState[] = [];
  for (let i = 0; i < args.workers; i++) {
    engines.push({ engine: await StockfishEngine.start('lite-single'), idx: i });
  }
  console.log(`[backfill-cp] engines ready.`);

  const workerOpts: WorkerOptions = {
    depth: args.depth,
    startPly: args.startPly,
    endPly: args.endPly,
    collectPerPly: perHandle,
  };

  try {
    while (totalAnalyzed < args.limit) {
      const remaining = args.limit - totalAnalyzed;
      const chunk = await pullChunk(client, args, remaining, pulled);
      if (chunk.length === 0) {
        console.log(`[backfill-cp] no more games to analyze — done.`);
        break;
      }
      for (const g of chunk) pulled.add(g.id);
      const chunkStart = Date.now();

      const queue = [...chunk];
      const results: AnalysisResult[] = [];
      const skipped: Array<{ id: string; reason: string }> = [];

      await Promise.all(
        engines.map((w) =>
          workerLoop(
            w,
            queue,
            workerOpts,
            (r) => results.push(r),
            (id, reason) => skipped.push({ id, reason }),
          ),
        ),
      );

      const written = await flushResults(client, results);
      let movesWritten = 0;
      if (perHandle) {
        movesWritten = await flushPerPly(client, results);
      }
      totalAnalyzed += results.length;
      totalSkipped += skipped.length;
      totalUpdated += written;
      totalMovesUpdated += movesWritten;

      const dt = (Date.now() - chunkStart) / 1000;
      const elapsedMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
      const rate = results.length / dt;
      console.log(
        `[backfill-cp] chunk: ${results.length} analyzed (${written} games, ${movesWritten} moves, ${skipped.length} skip) in ${dt.toFixed(1)}s @ ${rate.toFixed(1)}/s — total ${totalAnalyzed.toLocaleString()} after ${elapsedMin}min`,
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

  const elapsedSec = (Date.now() - startedAt) / 1000;
  const totalMin = (elapsedSec / 60).toFixed(1);
  console.log(`\n[backfill-cp] DONE`);
  console.log(`  analyzed         = ${totalAnalyzed.toLocaleString()}`);
  console.log(`  skipped          = ${totalSkipped.toLocaleString()}`);
  console.log(`  game updates     = ${totalUpdated.toLocaleString()}`);
  if (perHandle) console.log(`  move updates     = ${totalMovesUpdated.toLocaleString()}`);
  console.log(`  elapsed          = ${totalMin} min`);

  return {
    totalAnalyzed,
    totalSkipped,
    gameUpdates: totalUpdated,
    moveUpdates: totalMovesUpdated,
    elapsedSec,
  };
}

/**
 * Convenience wrapper for the leaks worker: run a small per-handle backfill
 * with sensible defaults (opening plies, modest concurrency).
 */
export function runScopedBackfillForHandle(args: {
  platform: 'lichess' | 'chess.com';
  handle: string;
  limit?: number;
  depth?: number;
  workers?: number;
  startPly?: number;
  endPly?: number;
}): Promise<BackfillStats> {
  return runBackfill({
    workers: args.workers ?? 2,
    depth: args.depth ?? 10,
    batch: args.limit ?? 100,
    limit: args.limit ?? 100,
    source: null,
    platform: args.platform,
    handle: args.handle.trim().toLowerCase(),
    startPly: args.startPly ?? 1,
    endPly: args.endPly ?? 60,
    shardN: null,
    shardK: null,
    scoutReadyOnly: false,
    coverage: false,
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await runBackfill(args);
}

// Only run as CLI when invoked directly, not on import.
const invokedAsCli = typeof process.argv[1] === 'string' && process.argv[1].endsWith('backfill.ts');
if (invokedAsCli) {
  main().catch((err) => {
    console.error('[backfill-cp] failed:', err);
    process.exit(1);
  });
}
