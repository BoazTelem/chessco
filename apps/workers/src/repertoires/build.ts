/**
 * Per-account opening-repertoire builder — Phase 2 of the player-id pipeline.
 *
 * For each scout-ready handle, builds white + black opening trees from the
 * games corpus and persists them as JSONB into player_repertoires.
 *
 * Tree shape mirrors apps/web/lib/prepare/tree-builder.ts so the /prepare
 * UI can consume it directly (Phase 3 wires DB-first loading).
 *
 * The web client uses Map<string, TreeNode>; we serialize as
 * Record<string, TreeNode> for JSON storage. Map/Record have the same
 * ergonomics with `for (const [k, v] of Object.entries(obj))` on the
 * read side.
 *
 * CLI usage:
 *   tsx src/repertoires/build.ts                                # backfill all at default depth (12)
 *   tsx src/repertoires/build.ts --depth 30 --limit 100         # deep tier for top-100 handles
 *   tsx src/repertoires/build.ts --handle danielnaroditsky --platform chess.com
 *   tsx src/repertoires/build.ts --rebuild                      # ignore existing rows at this depth
 *
 * Two tiers are stored in player_repertoires (PK on player_id+color+depth):
 *   - depth 12: every scout-ready handle, feeds the PGN matcher (Phase 4)
 *   - depth 30: top-N handles by games_seen, feeds /prepare deep trees
 */
import 'dotenv/config';
import type postgres from 'postgres';
import { getGamesDb } from '../db';

// ---------------------------------------------------------------------------
// Tree types — match apps/web/lib/prepare/types.ts shape (serializable form)
// ---------------------------------------------------------------------------

type Color = 'white' | 'black';

interface NextMoveStats {
  san: string;
  uci: string;
  fromSquare: string;
  toSquare: string;
  gamesCount: number;
  wins: number;
  draws: number;
  losses: number;
  weightedScore: number;
  lastPlayedAt: string; // ISO
  recentGameIds: string[];
}

interface TreeNode {
  fenKey: string;
  totalGames: number;
  totalWeighted: number;
  children: Record<string, NextMoveStats>;
}

type SerializedTree = Record<string, TreeNode>;

// ---------------------------------------------------------------------------
// Recency weight (mirrors apps/web/lib/prepare/recency.ts)
// ---------------------------------------------------------------------------

const HALF_LIFE_YEARS = 1.5;
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;
const LN2 = Math.log(2);

function recencyWeight(playedAt: Date, now: Date): number {
  const ageYears = Math.max(0, (now.getTime() - playedAt.getTime()) / MS_PER_YEAR);
  return Math.exp(-LN2 * (ageYears / HALF_LIFE_YEARS));
}

// ---------------------------------------------------------------------------
// Tree-building (mirrors buildTree() from apps/web/lib/prepare/tree-builder.ts)
// ---------------------------------------------------------------------------

const DEFAULT_DEPTH = 12;
const MAX_SAMPLE_GAMES_PER_MOVE = 6;
const STARTING_FEN_KEY_PARTS = 4; // first 4 fields of FEN: board + STM + castling + ep

interface MoveRow {
  game_id: string;
  ply: number;
  san: string;
  uci: string;
  fen_before: string;
}

interface GameRow {
  id: string;
  played_at: string;
  result: string; // '1-0' | '0-1' | '1/2-1/2'
  white_handle: string | null;
  black_handle: string | null;
}

interface GameRecord {
  id: string;
  playedAt: Date;
  playerColor: Color;
  result: 'win' | 'loss' | 'draw';
  movesSan: string[];
  movesUci: string[];
  fensBefore: string[];
}

function fenKey(fen: string): string {
  return fen.split(' ').slice(0, STARTING_FEN_KEY_PARTS).join(' ');
}

function uciToSquares(uci: string): { from: string; to: string } {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4) };
}

function ensureNode(tree: SerializedTree, key: string): TreeNode {
  let n = tree[key];
  if (!n) {
    n = { fenKey: key, totalGames: 0, totalWeighted: 0, children: {} };
    tree[key] = n;
  }
  return n;
}

function applyGameToTree(
  tree: SerializedTree,
  game: GameRecord,
  weight: number,
  maxPly: number,
): void {
  const limit = Math.min(game.movesSan.length, maxPly * 2);
  for (let i = 0; i < limit; i++) {
    const fk = game.fensBefore[i];
    const san = game.movesSan[i];
    const uci = game.movesUci[i];
    if (!fk || !san || !uci) break;
    // Player's move only when ply parity matches color (white = even-indexed, black = odd)
    const isPlayerMove = game.playerColor === 'white' ? i % 2 === 0 : i % 2 === 1;
    if (!isPlayerMove) continue;
    const node = ensureNode(tree, fk);
    node.totalGames++;
    node.totalWeighted += weight;
    let move = node.children[uci];
    if (!move) {
      const { from, to } = uciToSquares(uci);
      move = {
        san,
        uci,
        fromSquare: from,
        toSquare: to,
        gamesCount: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        weightedScore: 0,
        lastPlayedAt: game.playedAt.toISOString(),
        recentGameIds: [],
      };
      node.children[uci] = move;
    }
    move.gamesCount++;
    move.weightedScore += weight;
    if (game.result === 'win') move.wins++;
    else if (game.result === 'draw') move.draws++;
    else move.losses++;
    if (game.playedAt > new Date(move.lastPlayedAt)) {
      move.lastPlayedAt = game.playedAt.toISOString();
    }
    if (move.recentGameIds.length < MAX_SAMPLE_GAMES_PER_MOVE) {
      move.recentGameIds.push(game.id);
    }
  }
}

function buildTree(games: GameRecord[], color: Color, now: Date, depth: number): SerializedTree {
  const tree: SerializedTree = {};
  for (const g of games) {
    if (g.playerColor !== color) continue;
    const w = recencyWeight(g.playedAt, now);
    applyGameToTree(tree, g, w, depth);
  }
  return tree;
}

// ---------------------------------------------------------------------------
// Data fetching: load games + moves+positions for one handle
// ---------------------------------------------------------------------------

async function loadGameRecords(
  sql: postgres.Sql,
  platform: string,
  handle: string,
  depth: number,
): Promise<GameRecord[]> {
  const lower = handle.toLowerCase();
  // Load ALL games for the handle (no time filter — we partition into buckets
  // in memory below). Capped only by the corpus we've crawled.
  const games = await sql<GameRow[]>`
    SELECT id::text, played_at::text, result,
           white_handle_snapshot AS white_handle,
           black_handle_snapshot AS black_handle
    FROM games
    WHERE source = ${platform}
      AND (LOWER(white_handle_snapshot) = ${lower}
        OR LOWER(black_handle_snapshot) = ${lower})
  `;
  if (games.length === 0) return [];

  const gameIds = games.map((g) => g.id);
  // Load moves + their fen-before strings, capped at the requested depth (ply).
  const moves = await sql<MoveRow[]>`
    SELECT m.game_id::text, m.ply, m.san, m.uci, p.fen AS fen_before
    FROM moves m
    INNER JOIN positions p ON p.id = m.fen_before_id
    WHERE m.game_id = ANY(${gameIds}::uuid[])
      AND m.ply <= ${depth * 2}
    ORDER BY m.game_id, m.ply
  `;

  // Group moves by game_id.
  const movesByGame = new Map<string, MoveRow[]>();
  for (const m of moves) {
    let arr = movesByGame.get(m.game_id);
    if (!arr) {
      arr = [];
      movesByGame.set(m.game_id, arr);
    }
    arr.push(m);
  }

  // Reconstruct GameRecord.
  const records: GameRecord[] = [];
  for (const g of games) {
    const playerColor: Color = g.white_handle?.toLowerCase() === lower ? 'white' : 'black';
    let result: 'win' | 'loss' | 'draw';
    if (g.result === '1/2-1/2') result = 'draw';
    else if (g.result === '1-0') result = playerColor === 'white' ? 'win' : 'loss';
    else if (g.result === '0-1') result = playerColor === 'black' ? 'win' : 'loss';
    else continue; // unrecognized result
    const ms = movesByGame.get(g.id);
    if (!ms || ms.length === 0) continue;
    records.push({
      id: g.id,
      playedAt: new Date(g.played_at),
      playerColor,
      result,
      movesSan: ms.map((m) => m.san),
      movesUci: ms.map((m) => m.uci),
      fensBefore: ms.map((m) => fenKey(m.fen_before)),
    });
  }
  return records;
}

// ---------------------------------------------------------------------------
// Time-bucket partitioning + per-(bucket × color) build + persist
// ---------------------------------------------------------------------------

type TimeBucket = 'recent_3mo' | 'recent_12mo' | 'recent_36mo' | 'all_time';
const BUCKETS: { name: TimeBucket; days: number | null }[] = [
  { name: 'recent_3mo', days: 90 },
  { name: 'recent_12mo', days: 365 },
  { name: 'recent_36mo', days: 1095 },
  { name: 'all_time', days: null },
];

function gamesInBucket(games: GameRecord[], bucketDays: number | null, now: Date): GameRecord[] {
  if (bucketDays === null) return games;
  const cutoff = now.getTime() - bucketDays * 24 * 60 * 60 * 1000;
  return games.filter((g) => g.playedAt.getTime() >= cutoff);
}

export interface PersistStats {
  buckets_written: number;
  total_white_nodes: number;
  total_black_nodes: number;
  games_total: number;
  games_white: number;
  games_black: number;
}

/**
 * Resolve a (platform, handle) pair to its corpus-side handles.id. Returns
 * null if the handle is unknown (never crawled). Caller decides how to
 * react — typically by enqueueing a discovery / crawl step.
 */
export async function lookupHandleId(
  sql: postgres.Sql,
  platform: string,
  handle: string,
): Promise<{ id: string; platform: string; handle: string } | null> {
  const rows = await sql<{ id: string; handle: string; platform: string }[]>`
    SELECT id::text, handle, platform FROM handles
    WHERE platform = ${platform} AND LOWER(handle) = ${handle.toLowerCase()}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Returns the time-bucket × color combos already present in
 * player_repertoires for this handle. Used by the leaks worker to decide
 * whether to (re)build before scoring.
 */
export async function existingRepertoireCombos(
  sql: postgres.Sql,
  playerId: string,
  depth: number,
): Promise<Array<{ color: 'white' | 'black'; time_bucket: string }>> {
  return sql<Array<{ color: 'white' | 'black'; time_bucket: string }>>`
    SELECT color, time_bucket FROM player_repertoires
    WHERE player_id = ${playerId}::uuid AND depth = ${depth}
  `;
}

export async function buildAndPersist(
  sql: postgres.Sql,
  playerId: string,
  platform: string,
  handle: string,
  depth: number,
): Promise<PersistStats> {
  const now = new Date();
  const allGames = await loadGameRecords(sql, platform, handle, depth);
  const stats: PersistStats = {
    buckets_written: 0,
    total_white_nodes: 0,
    total_black_nodes: 0,
    games_total: allGames.length,
    games_white: allGames.filter((g) => g.playerColor === 'white').length,
    games_black: allGames.filter((g) => g.playerColor === 'black').length,
  };
  if (allGames.length === 0) return stats;

  for (const bucket of BUCKETS) {
    const bucketGames = gamesInBucket(allGames, bucket.days, now);
    if (bucketGames.length === 0) continue;
    const since =
      bucket.days === null
        ? new Date(Math.min(...bucketGames.map((g) => g.playedAt.getTime())))
        : new Date(now.getTime() - bucket.days * 24 * 60 * 60 * 1000);
    const until = now;

    for (const color of ['white', 'black'] as const) {
      const colorGames = bucketGames.filter((g) => g.playerColor === color);
      if (colorGames.length === 0) continue;
      const tree = buildTree(bucketGames, color, now, depth);
      const nodeCount = Object.keys(tree).length;
      if (color === 'white') stats.total_white_nodes += nodeCount;
      else stats.total_black_nodes += nodeCount;
      stats.buckets_written++;

      await sql`
        INSERT INTO player_repertoires
          (player_id, color, depth, time_bucket, tree, games_window, bucket_since, bucket_until, built_at)
        VALUES (
          ${playerId}::uuid, ${color}, ${depth}, ${bucket.name},
          ${JSON.stringify(tree)}::jsonb, ${colorGames.length},
          ${since.toISOString()}, ${until.toISOString()}, NOW()
        )
        ON CONFLICT (player_id, color, depth, time_bucket) DO UPDATE SET
          tree = EXCLUDED.tree,
          games_window = EXCLUDED.games_window,
          bucket_since = EXCLUDED.bucket_since,
          bucket_until = EXCLUDED.bucket_until,
          built_at = NOW()
      `;
    }
  }
  return stats;
}

// ---------------------------------------------------------------------------
// CLI / backfill
// ---------------------------------------------------------------------------

interface CliArgs {
  handle: string | null;
  platform: 'chess.com' | 'lichess' | null;
  limit: number | null;
  rebuild: boolean;
  depth: number;
  concurrency: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    handle: null,
    platform: null,
    limit: null,
    rebuild: false,
    depth: DEFAULT_DEPTH,
    concurrency: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--handle' && argv[i + 1]) args.handle = argv[++i]!;
    else if (a === '--platform' && argv[i + 1]) {
      const p = argv[++i]!;
      if (p !== 'chess.com' && p !== 'lichess') throw new Error(`bad --platform ${p}`);
      args.platform = p;
    } else if (a === '--limit' && argv[i + 1]) args.limit = Number.parseInt(argv[++i]!, 10);
    else if (a === '--depth' && argv[i + 1]) args.depth = Number.parseInt(argv[++i]!, 10);
    else if (a === '--concurrency' && argv[i + 1])
      args.concurrency = Number.parseInt(argv[++i]!, 10);
    else if (a === '--rebuild') args.rebuild = true;
    else throw new Error(`unrecognized arg: ${a}`);
  }
  if (args.depth < 1 || args.depth > 60) throw new Error(`--depth must be 1..60`);
  if (args.concurrency < 1 || args.concurrency > 6)
    throw new Error(`--concurrency must be 1..6 (DB pool max=4 limits this)`);
  return args;
}

async function listPendingHandles(
  sql: postgres.Sql,
  limit: number | null,
  rebuild: boolean,
  depth: number,
): Promise<{ id: string; platform: string; handle: string; games_seen: number }[]> {
  // Scout-ready handles missing a repertoire AT THIS DEPTH.
  if (rebuild) {
    return sql<{ id: string; platform: string; handle: string; games_seen: number }[]>`
      SELECT id::text, platform, handle, games_seen FROM handles
      WHERE scout_ready_at IS NOT NULL
      ORDER BY games_seen DESC
      ${limit ? sql`LIMIT ${limit}` : sql``}
    `;
  }
  return sql<{ id: string; platform: string; handle: string; games_seen: number }[]>`
    SELECT h.id::text, h.platform, h.handle, h.games_seen
    FROM handles h
    LEFT JOIN player_repertoires pr
      ON pr.player_id = h.id AND pr.depth = ${depth}
    WHERE h.scout_ready_at IS NOT NULL AND pr.player_id IS NULL
    ORDER BY h.games_seen DESC
    ${limit ? sql`LIMIT ${limit}` : sql``}
  `;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { client } = getGamesDb();
  try {
    if (args.handle && args.platform) {
      const rows = await client<{ id: string; handle: string; platform: string }[]>`
        SELECT id::text, handle, platform FROM handles
        WHERE platform = ${args.platform} AND LOWER(handle) = ${args.handle.toLowerCase()}
      `;
      if (rows.length === 0) {
        console.error(`handle ${args.platform}/${args.handle} not in handles table`);
        process.exit(2);
      }
      const r = rows[0]!;
      console.log(
        `[repertoires] building depth=${args.depth} for ${r.platform}/${r.handle} (id=${r.id})…`,
      );
      const t0 = Date.now();
      const out = await buildAndPersist(client, r.id, r.platform, r.handle, args.depth);
      console.log(
        `[repertoires] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ` +
          `games_total=${out.games_total} (white=${out.games_white} black=${out.games_black}), ` +
          `buckets_written=${out.buckets_written}, ` +
          `total_white_nodes=${out.total_white_nodes}, total_black_nodes=${out.total_black_nodes}`,
      );
      return;
    }

    const pending = await listPendingHandles(client, args.limit, args.rebuild, args.depth);
    console.log(
      `[repertoires] backfill depth=${args.depth} concurrency=${args.concurrency}: ${pending.length} handle(s) to build`,
    );
    let done = 0;
    let totalGames = 0;
    let totalWhiteNodes = 0;
    let totalBlackNodes = 0;
    let totalBuckets = 0;
    const t0 = Date.now();
    // Chunked Promise.all gives us N-wide concurrency. Each handle still uses
    // 1 connection at a time (sequential queries within), so concurrency=N
    // takes N connections from the pool (max=4).
    for (let i = 0; i < pending.length; i += args.concurrency) {
      const chunk = pending.slice(i, i + args.concurrency);
      const results = await Promise.all(
        chunk.map(async (h) => {
          try {
            const out = await buildAndPersist(client, h.id, h.platform, h.handle, args.depth);
            return { h, out, err: null as Error | null };
          } catch (err) {
            return { h, out: null, err: err instanceof Error ? err : new Error(String(err)) };
          }
        }),
      );
      for (const { h, out, err } of results) {
        if (err) {
          console.warn(`  ! ${h.platform}/${h.handle}: ${err.message}`);
          continue;
        }
        if (!out) continue;
        done++;
        totalGames += out.games_total;
        totalWhiteNodes += out.total_white_nodes;
        totalBlackNodes += out.total_black_nodes;
        totalBuckets += out.buckets_written;
        if (done % 25 === 0 || h.games_seen > 5000) {
          const elapsedSec = (Date.now() - t0) / 1000;
          console.log(
            `  [${done}/${pending.length}] ${h.platform}/${h.handle} (games_seen=${h.games_seen}) — ` +
              `${out.games_total}g across ${out.buckets_written} bucket-rows, ` +
              `${out.total_white_nodes}w + ${out.total_black_nodes}b nodes ` +
              `(${elapsedSec.toFixed(1)}s elapsed)`,
          );
        }
      }
    }
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `[repertoires] backfill done in ${dur}s — ` +
        `built ${done}/${pending.length}; ${totalBuckets} bucket-rows; ` +
        `total games=${totalGames}, nodes=${totalWhiteNodes + totalBlackNodes}`,
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

const invokedAsCli = typeof process.argv[1] === 'string' && process.argv[1].endsWith('build.ts');
if (invokedAsCli) {
  main().catch((err) => {
    console.error('[repertoires] failed:', err);
    process.exit(1);
  });
}
