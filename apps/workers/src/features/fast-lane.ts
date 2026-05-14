/**
 * Fast-lane fingerprint worker — streaming PGN → fingerprint upsert,
 * skipping the heavy games/moves/positions writes used by the full crawler.
 *
 * The full pipeline (chesscom-crawl → ingestBatch → features:run) writes
 *   · games        ~  1 row per game
 *   · positions    ~ 60 rows per game
 *   · moves        ~ 30 rows per game
 * Then features:run reads them all back to aggregate per (platform, handle).
 *
 * For breadth — adding tens of thousands of fingerprints to grow the
 * Stage-3 search universe — most of that data is wasted. Fast lane
 * inverts the flow:
 *   1. Take a list of handles (CLI --handle, or --tier from platform_players)
 *   2. For each handle: fetch its archive months via the chess.com Pub API
 *   3. Accumulate per-game features in memory (no game/move/position rows)
 *   4. On all months processed: compute V0 features + sparse terms, upsert
 *      handles + style_features + account_fingerprints + fingerprint_terms.
 *
 * Trade-off: fast-lane handles can't get Stockfish cp-loss enrichment or
 * repertoire-tree building because we never persist their per-game data.
 * Those are reserved for the "full-lane" T1/P0 handles that flow through
 * the regular crawler. Document at the call site whether a handle is
 * fast-lane (breadth) or full-lane (depth).
 *
 * Usage:
 *   pnpm --filter @chessco/workers features:fast-lane --handle hikaru
 *   pnpm --filter @chessco/workers features:fast-lane --tier T1 --max-handles 100
 *   pnpm --filter @chessco/workers features:fast-lane --tier T1 --concurrency 5
 *   pnpm --filter @chessco/workers features:fast-lane --tier T1 --months-back 24
 *   pnpm --filter @chessco/workers features:fast-lane --tier T1 --dry-run
 *
 * Currently supports chess.com only. Lichess equivalent is queued behind
 * a working /api/games/user NDJSON fetcher refactor.
 */
import 'dotenv/config';
import { Chess } from 'chess.js';
import type postgres from 'postgres';
import { getDb, getGamesDb } from '../db';
import {
  ChesscomApiError,
  fetchArchiveMonth,
  fetchArchivesList,
  type ChesscomArchiveGame,
} from '../lib/chesscom-api';
import { emptyChesscomFilterStats, shouldIngestChesscom } from '../chesscom-crawl/filter';
import {
  extractFeaturesV0,
  extractFingerprintTerms,
  type FingerprintTerm,
  type GameRow,
} from './extract';
import type { PlayerFeaturesV0 } from './types';

const MOVE_SEQ_PLY_COUNT = 12;
const DEFAULT_MONTHS_BACK = 12;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MIN_GAMES = 10;

type PriorityTier = 'T1' | 'T2' | 'T3';

interface CliArgs {
  platform: 'chess.com';
  handle: string | null;
  tier: PriorityTier | null;
  maxHandles: number | null;
  monthsBack: number;
  concurrency: number;
  minGames: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    platform: 'chess.com',
    handle: null,
    tier: null,
    maxHandles: null,
    monthsBack: DEFAULT_MONTHS_BACK,
    concurrency: DEFAULT_CONCURRENCY,
    minGames: DEFAULT_MIN_GAMES,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--platform' && argv[i + 1]) {
      const p = argv[++i]!;
      if (p !== 'chess.com') {
        throw new Error(`--platform: only 'chess.com' supported in fast-lane v1 (got ${p})`);
      }
      out.platform = p;
    } else if (a === '--handle' && argv[i + 1]) {
      out.handle = argv[++i]!.toLowerCase();
    } else if (a === '--tier' && argv[i + 1]) {
      const t = argv[++i]!.toUpperCase();
      if (t !== 'T1' && t !== 'T2' && t !== 'T3') {
        throw new Error(`--tier must be T1|T2|T3 (got ${t})`);
      }
      out.tier = t;
    } else if (a === '--max-handles' && argv[i + 1]) {
      out.maxHandles = Number.parseInt(argv[++i]!, 10);
    } else if (a === '--months-back' && argv[i + 1]) {
      out.monthsBack = Number.parseInt(argv[++i]!, 10);
    } else if (a === '--concurrency' && argv[i + 1]) {
      out.concurrency = Number.parseInt(argv[++i]!, 10);
    } else if (a === '--min-games' && argv[i + 1]) {
      out.minGames = Number.parseInt(argv[++i]!, 10);
    } else if (a === '--dry-run') {
      out.dryRun = true;
    } else {
      throw new Error(`Unrecognized arg: ${a}`);
    }
  }
  if (!out.handle && !out.tier) {
    throw new Error('Must provide --handle or --tier');
  }
  return out;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

/** Parse first N plies SAN from a chess.com archive game's PGN. */
function pgnToMoveSeqPrefix(pgn: string | undefined, n = MOVE_SEQ_PLY_COUNT): string {
  if (!pgn || pgn.length === 0) return '';
  const chess = new Chess();
  try {
    chess.loadPgn(pgn, { strict: false });
  } catch {
    return '';
  }
  const history = chess.history();
  if (history.length === 0) return '';
  return history.slice(0, n).join(' ');
}

/** Lightweight ChesscomArchiveGame → GameRow (no DB-bound moves/positions). */
function chesscomToGameRow(game: ChesscomArchiveGame, targetHandle: string): GameRow | null {
  const target = targetHandle.toLowerCase();
  const whiteHandle = game.white?.username?.toLowerCase() ?? '';
  const blackHandle = game.black?.username?.toLowerCase() ?? '';
  let color: 'white' | 'black';
  let opponentRating: number | null;
  if (whiteHandle === target) {
    color = 'white';
    opponentRating = game.black?.rating ?? null;
  } else if (blackHandle === target) {
    color = 'black';
    opponentRating = game.white?.rating ?? null;
  } else {
    // Target not in this game — shouldn't happen for archive_month of target,
    // but guard.
    return null;
  }

  // Map per-side chess.com result codes to canonical 1-0/0-1/1/2-1/2.
  const wr = game.white?.result;
  const br = game.black?.result;
  let result: '1-0' | '0-1' | '1/2-1/2' | null = null;
  if (wr === 'win') result = '1-0';
  else if (br === 'win') result = '0-1';
  else if (
    wr === 'agreed' ||
    wr === 'repetition' ||
    wr === 'stalemate' ||
    wr === 'insufficient' ||
    wr === '50move' ||
    wr === 'timevsinsufficient'
  )
    result = '1/2-1/2';
  if (!result) return null;

  const playedAt = game.end_time ? new Date(game.end_time * 1000) : null;
  if (!playedAt || !Number.isFinite(playedAt.getTime())) return null;

  const timeClass = game.time_class === 'daily' ? 'correspondence' : (game.time_class ?? null);
  const moveSeq = pgnToMoveSeqPrefix(game.pgn);
  const plyCount = countPlies(game.pgn);
  const termination = wr && br ? `${wr}/${br}` : null;

  return {
    color,
    result,
    time_class: timeClass,
    opening_eco: game.eco ?? null,
    ply_count: plyCount,
    termination,
    opponent_rating: opponentRating,
    played_at: playedAt,
    move_seq_prefix: moveSeq,
  };
}

/** Counts SAN plies in a PGN move text by tokenizing — cheaper than a full
 *  chess.js replay when we only need a ply count. Skips comments, NAGs,
 *  result tokens, and move-number labels. */
function countPlies(pgn: string | undefined): number {
  if (!pgn) return 0;
  const idx = pgn.search(/\r?\n\r?\n/);
  if (idx < 0) return 0;
  const moveText = pgn.slice(idx);
  let count = 0;
  let i = 0;
  while (i < moveText.length) {
    const c = moveText[i]!;
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    if (c === '{') {
      const e = moveText.indexOf('}', i + 1);
      if (e < 0) break;
      i = e + 1;
      continue;
    }
    if (c === '(') {
      let depth = 1;
      i++;
      while (i < moveText.length && depth > 0) {
        if (moveText[i] === '(') depth++;
        else if (moveText[i] === ')') depth--;
        i++;
      }
      continue;
    }
    if (c === '$') {
      while (i < moveText.length && moveText[i] !== ' ' && moveText[i] !== '\n') i++;
      continue;
    }
    let j = i;
    while (j < moveText.length && !' \t\r\n{('.includes(moveText[j]!)) j++;
    const tok = moveText.slice(i, j);
    i = j;
    if (tok === '1-0' || tok === '0-1' || tok === '1/2-1/2' || tok === '*') break;
    if (/^\d+\.+$/.test(tok)) continue;
    count++;
  }
  return count;
}

/** /pub/player/{u}/games/archives is a flat list of month URLs. Take the
 *  most recent N (sorted by URL date asc, slice from the end). */
function selectRecentArchives(urls: string[], monthsBack: number): string[] {
  // URLs end with /games/YYYY/MM — sort by string is sort by date.
  const sorted = [...urls].sort();
  return sorted.slice(Math.max(0, sorted.length - monthsBack));
}

interface HandleResult {
  handle: string;
  gamesAccepted: number;
  gamesSeen: number;
  fingerprintWritten: boolean;
  skipReason: string | null;
  durationMs: number;
}

/** Process one handle end-to-end: fetch archive months, accumulate game rows,
 *  upsert fingerprint+terms (unless dry-run). Returns a per-handle summary. */
async function processHandle(
  cloudSql: postgres.Sql,
  handle: string,
  args: CliArgs,
): Promise<HandleResult> {
  const t0 = Date.now();
  const result: HandleResult = {
    handle,
    gamesAccepted: 0,
    gamesSeen: 0,
    fingerprintWritten: false,
    skipReason: null,
    durationMs: 0,
  };

  let archiveUrls: string[];
  try {
    archiveUrls = await fetchArchivesList(handle);
  } catch (err) {
    if (err instanceof ChesscomApiError && err.status === 404) {
      result.skipReason = 'handle 404 from /pub/player';
      result.durationMs = Date.now() - t0;
      return result;
    }
    throw err;
  }
  if (archiveUrls.length === 0) {
    result.skipReason = 'no archives';
    result.durationMs = Date.now() - t0;
    return result;
  }
  const targetUrls = selectRecentArchives(archiveUrls, args.monthsBack);

  const filterStats = emptyChesscomFilterStats();
  const buffer: GameRow[] = [];

  for (const url of targetUrls) {
    let games: ChesscomArchiveGame[];
    try {
      games = await fetchArchiveMonth(url);
    } catch (err) {
      if (err instanceof ChesscomApiError && err.status === 404) {
        // Listed but empty — skip silently.
        continue;
      }
      throw err;
    }
    for (const g of games) {
      result.gamesSeen++;
      if (!shouldIngestChesscom(g, filterStats)) continue;
      const row = chesscomToGameRow(g, handle);
      if (row) buffer.push(row);
    }
  }
  result.gamesAccepted = buffer.length;

  if (buffer.length < args.minGames) {
    result.skipReason = `${buffer.length} games < ${args.minGames} minimum`;
    result.durationMs = Date.now() - t0;
    return result;
  }

  if (args.dryRun) {
    result.skipReason = 'dry-run';
    result.durationMs = Date.now() - t0;
    return result;
  }

  const features = extractFeaturesV0(buffer);
  const terms = extractFingerprintTerms(features);

  await writeFingerprint(cloudSql, args.platform, handle, buffer.length, features, terms);
  result.fingerprintWritten = true;
  result.durationMs = Date.now() - t0;
  return result;
}

/** Upsert handles + style_features + account_fingerprints + fingerprint_terms
 *  for a single (platform, handle) pair. Sequence is chosen so foreign keys
 *  (handle_id → handles.id) resolve cleanly. Not transactional — each upsert
 *  is idempotent on its own. */
async function writeFingerprint(
  sql: postgres.Sql,
  platform: 'chess.com',
  handle: string,
  gamesWindow: number,
  features: PlayerFeaturesV0,
  terms: FingerprintTerm[],
): Promise<void> {
  const earliest = new Date(features.earliest_played_at);
  const latest = new Date(features.latest_played_at);

  // 1. Upsert handle, get its uuid.
  const handleRows = await sql<{ id: string }[]>`
    INSERT INTO handles (platform, handle, games_seen, first_seen_at, last_seen_at)
    VALUES (${platform}, ${handle.toLowerCase()}, ${gamesWindow},
            ${earliest.toISOString()}, ${latest.toISOString()})
    ON CONFLICT (platform, handle) DO UPDATE SET
      games_seen = GREATEST(handles.games_seen, EXCLUDED.games_seen),
      first_seen_at = LEAST(handles.first_seen_at, EXCLUDED.first_seen_at),
      last_seen_at = GREATEST(handles.last_seen_at, EXCLUDED.last_seen_at)
    RETURNING id
  `;
  const handleId = handleRows[0]?.id;
  if (!handleId) throw new Error(`handles upsert returned no rows for ${platform}/${handle}`);

  const featuresJson = JSON.stringify(features);
  const dominantTc = argmaxKey(features.time_class);
  const whiteShare = features.games_total > 0 ? features.games_as_white / features.games_total : 0;
  const medianRating =
    features.avg_opponent_rating === null ? null : Math.round(features.avg_opponent_rating);

  // 2. style_features (canonical V0 JSONB).
  await sql`
    INSERT INTO style_features (player_id, features, games_window)
    VALUES (${handleId}, ${featuresJson}, ${gamesWindow})
    ON CONFLICT (player_id) DO UPDATE SET
      features = EXCLUDED.features,
      games_window = EXCLUDED.games_window,
      computed_at = NOW()
  `;

  // 3. account_fingerprints (scalar prefilter denorm).
  await sql`
    INSERT INTO account_fingerprints (
      handle_id, platform, handle, games_window,
      median_rating, dominant_time_class, white_share,
      earliest_played_at, latest_played_at, scalar_summary
    ) VALUES (
      ${handleId}, ${platform}, ${handle.toLowerCase()}, ${gamesWindow},
      ${medianRating}, ${dominantTc}, ${whiteShare},
      ${features.earliest_played_at}, ${features.latest_played_at}, ${featuresJson}
    )
    ON CONFLICT (handle_id) DO UPDATE SET
      games_window = EXCLUDED.games_window,
      median_rating = EXCLUDED.median_rating,
      dominant_time_class = EXCLUDED.dominant_time_class,
      white_share = EXCLUDED.white_share,
      earliest_played_at = EXCLUDED.earliest_played_at,
      latest_played_at = EXCLUDED.latest_played_at,
      scalar_summary = EXCLUDED.scalar_summary,
      built_at = NOW()
  `;

  // 4. fingerprint_terms (delete-then-insert per handle to retire stale terms).
  await sql`DELETE FROM fingerprint_terms WHERE handle_id = ${handleId}`;
  if (terms.length > 0) {
    const insert = sql as unknown as (rs: object[], ...cs: string[]) => postgres.Helper<object[]>;
    // 4 cols × N rows; 10000 rows = 40k params, safely under 65k cap.
    const CHUNK = 10000;
    const rows = terms.map((t) => ({
      handle_id: handleId,
      kind: t.kind,
      term: t.term,
      weight: t.weight,
    }));
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await sql`
        INSERT INTO fingerprint_terms
          ${insert(chunk, 'handle_id', 'kind', 'term', 'weight')}
        ON CONFLICT (handle_id, kind, term) DO UPDATE SET
          weight = EXCLUDED.weight
      `;
    }
  }
}

function argmaxKey(histogram: Record<string, number>): string | null {
  let best: string | null = null;
  let bestN = -Infinity;
  for (const [k, v] of Object.entries(histogram)) {
    if (v > bestN) {
      best = k;
      bestN = v;
    }
  }
  return best;
}

/** Read handle list from Supabase platform_players. Mirrors the tier
 *  predicates in chesscom-crawl/seed.ts. */
async function selectHandles(
  supaSql: postgres.Sql,
  tier: PriorityTier,
  maxHandles: number | null,
): Promise<string[]> {
  type Row = { handle: string };
  // Order by first_seen_at — same as seed.ts for stable, scout-ready-first
  // batching. Concurrency below handles parallelism.
  if (tier === 'T1') {
    const rows = maxHandles
      ? await supaSql<Row[]>`
          SELECT handle FROM platform_players
          WHERE platform = 'chess.com'
            AND (
              COALESCE(rating_blitz, 0) >= 1600
              OR COALESCE(rating_rapid, 0) >= 1600
              OR title IS NOT NULL
              OR claimed_federation_player_id IS NOT NULL
              OR is_verified_oauth = true
            )
          ORDER BY first_seen_at ASC
          LIMIT ${maxHandles}`
      : await supaSql<Row[]>`
          SELECT handle FROM platform_players
          WHERE platform = 'chess.com'
            AND (
              COALESCE(rating_blitz, 0) >= 1600
              OR COALESCE(rating_rapid, 0) >= 1600
              OR title IS NOT NULL
              OR claimed_federation_player_id IS NOT NULL
              OR is_verified_oauth = true
            )
          ORDER BY first_seen_at ASC`;
    return rows.map((r) => r.handle.toLowerCase());
  }
  if (tier === 'T2') {
    const rows = maxHandles
      ? await supaSql<Row[]>`
          SELECT handle FROM platform_players
          WHERE platform = 'chess.com'
            AND title IS NULL
            AND (
              (rating_blitz BETWEEN 1300 AND 1599)
              OR (rating_rapid BETWEEN 1300 AND 1599)
            )
            AND NOT (
              COALESCE(rating_blitz, 0) >= 1600
              OR COALESCE(rating_rapid, 0) >= 1600
            )
          ORDER BY first_seen_at ASC
          LIMIT ${maxHandles}`
      : await supaSql<Row[]>`
          SELECT handle FROM platform_players
          WHERE platform = 'chess.com'
            AND title IS NULL
            AND (
              (rating_blitz BETWEEN 1300 AND 1599)
              OR (rating_rapid BETWEEN 1300 AND 1599)
            )
            AND NOT (
              COALESCE(rating_blitz, 0) >= 1600
              OR COALESCE(rating_rapid, 0) >= 1600
            )
          ORDER BY first_seen_at ASC`;
    return rows.map((r) => r.handle.toLowerCase());
  }
  // T3
  const rows = maxHandles
    ? await supaSql<Row[]>`
        SELECT handle FROM platform_players
        WHERE platform = 'chess.com'
          AND title IS NULL
          AND (
            (rating_blitz BETWEEN 1000 AND 1299)
            OR (rating_rapid BETWEEN 1000 AND 1299)
          )
          AND NOT (
            COALESCE(rating_blitz, 0) >= 1300
            OR COALESCE(rating_rapid, 0) >= 1300
          )
        ORDER BY first_seen_at ASC
        LIMIT ${maxHandles}`
    : await supaSql<Row[]>`
        SELECT handle FROM platform_players
        WHERE platform = 'chess.com'
          AND title IS NULL
          AND (
            (rating_blitz BETWEEN 1000 AND 1299)
            OR (rating_rapid BETWEEN 1000 AND 1299)
          )
          AND NOT (
            COALESCE(rating_blitz, 0) >= 1300
            OR COALESCE(rating_rapid, 0) >= 1300
          )
        ORDER BY first_seen_at ASC`;
  return rows.map((r) => r.handle.toLowerCase());
}

/** Process handles concurrently with a simple worker-pool semaphore. */
async function runPool(
  cloudSql: postgres.Sql,
  handles: string[],
  args: CliArgs,
): Promise<HandleResult[]> {
  const results: HandleResult[] = new Array(handles.length);
  let next = 0;
  let processed = 0;

  async function worker(id: number): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= handles.length) return;
      const handle = handles[i]!;
      try {
        const r = await processHandle(cloudSql, handle, args);
        results[i] = r;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results[i] = {
          handle,
          gamesAccepted: 0,
          gamesSeen: 0,
          fingerprintWritten: false,
          skipReason: `error: ${msg.slice(0, 200)}`,
          durationMs: 0,
        };
        console.warn(`  ! [w${id}] ${handle}: ${msg.slice(0, 200)}`);
      }
      processed++;
      const r = results[i]!;
      if (processed % 10 === 0 || r.fingerprintWritten) {
        console.log(
          `  · [w${id}] ${handle.padEnd(24)} ` +
            `games=${fmt(r.gamesAccepted).padStart(4)}/${fmt(r.gamesSeen).padStart(4)} ` +
            `${r.fingerprintWritten ? 'WROTE' : `skip:${r.skipReason ?? '?'}`} ` +
            `(${r.durationMs}ms) [${processed}/${handles.length}]`,
        );
      }
    }
  }

  const workers = Array.from({ length: args.concurrency }, (_, i) => worker(i + 1));
  await Promise.all(workers);
  return results;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const { client: cloudSql } = getGamesDb();
  let supaSql: postgres.Sql | null = null;

  try {
    let handles: string[];
    if (args.handle) {
      handles = [args.handle];
    } else if (args.tier) {
      const supabase = getDb();
      supaSql = supabase.client;
      handles = await selectHandles(supaSql, args.tier, args.maxHandles);
      console.log(
        `[fast-lane] tier=${args.tier} → ${fmt(handles.length)} handles ` +
          `(months-back=${args.monthsBack}, concurrency=${args.concurrency}, ` +
          `min-games=${args.minGames}${args.dryRun ? ', DRY RUN' : ''})`,
      );
    } else {
      throw new Error('unreachable: parseArgs guards this');
    }

    if (handles.length === 0) {
      console.log('[fast-lane] no handles to process.');
      return;
    }

    const t0 = Date.now();
    const results = await runPool(cloudSql, handles, args);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);

    const wrote = results.filter((r) => r.fingerprintWritten).length;
    const skipped = results.filter((r) => !r.fingerprintWritten).length;
    const totalGames = results.reduce((s, r) => s + r.gamesAccepted, 0);
    console.log(`\n[fast-lane] DONE in ${dt}s`);
    console.log(`  handles processed: ${fmt(results.length)}`);
    console.log(`  fingerprints written: ${fmt(wrote)}`);
    console.log(`  skipped: ${fmt(skipped)}`);
    console.log(`  total games accepted: ${fmt(totalGames)}`);

    // Top 5 skip reasons for diagnostic.
    const skipReasons = new Map<string, number>();
    for (const r of results) {
      if (!r.fingerprintWritten && r.skipReason) {
        const reason = r.skipReason.startsWith('error:') ? 'error' : r.skipReason;
        skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
      }
    }
    if (skipReasons.size > 0) {
      console.log('  skip reasons:');
      for (const [reason, n] of [...skipReasons.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)) {
        console.log(`    · ${reason}: ${fmt(n)}`);
      }
    }
  } finally {
    await cloudSql.end({ timeout: 5 });
    if (supaSql) await supaSql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('fast-lane worker failed:', err);
  process.exit(1);
});
