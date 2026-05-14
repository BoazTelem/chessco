/**
 * Lichess fast-lane fingerprint worker — same shape as chess.com fast-lane
 * but uses Lichess /api/games/user NDJSON streaming. Skips the heavy
 * games/moves/positions writes used by the full crawler.
 *
 * One round-trip per handle returns all of their games as ndjson:
 *   GET https://lichess.org/api/games/user/{username}
 *     ?rated=true              — skip casual
 *     &max=N                   — cap (default 1000 — recent activity window)
 *     &pgnInJson=false         — we don't need full PGN, just moves field
 *     &clocks=false&evals=false&opening=true
 *     Accept: application/x-ndjson
 *
 * Each line is a Lichess game object. We extract:
 *   color (from target handle vs players.white.user.name)
 *   result (win/loss/draw → 1-0/0-1/1/2-1/2)
 *   time_class (speed)
 *   opening_eco (opening.eco)
 *   ply_count (count moves in `moves` string)
 *   opponent_rating
 *   played_at (lastMoveAt)
 *   move_seq_prefix (first 12 SAN tokens from `moves`)
 *
 * Uses LICHESS_API_TOKEN from env if present for 20 req/s rate-limit headroom;
 * falls back to unauthenticated 1 req/s otherwise.
 *
 * Usage:
 *   pnpm --filter @chessco/workers features:fast-lane-lichess --handle DrNykterstein
 *   pnpm --filter @chessco/workers features:fast-lane-lichess --tier T1 --max-handles 100
 *   pnpm --filter @chessco/workers features:fast-lane-lichess --tier T1 --concurrency 3
 *   pnpm --filter @chessco/workers features:fast-lane-lichess --tier T1 --max-games 500
 *   pnpm --filter @chessco/workers features:fast-lane-lichess --tier T1 --dry-run
 */
import 'dotenv/config';
import type postgres from 'postgres';
import { getDb, getGamesDb } from '../db';
import { fetchUserGamesNdjson } from '../lib/lichess-api';
import {
  extractFeaturesV0,
  extractFingerprintTerms,
  type FingerprintTerm,
  type GameRow,
} from './extract';
import type { PlayerFeaturesV0 } from './types';

const DEFAULT_MAX_GAMES = 1000;
const DEFAULT_CONCURRENCY = 3; // lower than chess.com because each call is bigger
const DEFAULT_MIN_GAMES = 10;
const MOVE_SEQ_PLY_COUNT = 12;

type PriorityTier = 'T1' | 'T2' | 'T3';

interface CliArgs {
  handle: string | null;
  tier: PriorityTier | null;
  maxHandles: number | null;
  maxGames: number;
  concurrency: number;
  minGames: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    handle: null,
    tier: null,
    maxHandles: null,
    maxGames: DEFAULT_MAX_GAMES,
    concurrency: DEFAULT_CONCURRENCY,
    minGames: DEFAULT_MIN_GAMES,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--handle' && argv[i + 1]) out.handle = argv[++i]!.toLowerCase();
    else if (a === '--tier' && argv[i + 1]) {
      const t = argv[++i]!.toUpperCase();
      if (t !== 'T1' && t !== 'T2' && t !== 'T3') {
        throw new Error(`--tier must be T1|T2|T3 (got ${t})`);
      }
      out.tier = t;
    } else if (a === '--max-handles' && argv[i + 1]) {
      out.maxHandles = Number.parseInt(argv[++i]!, 10);
    } else if (a === '--max-games' && argv[i + 1]) {
      out.maxGames = Number.parseInt(argv[++i]!, 10);
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

/** One Lichess game from /api/games/user ndjson. Fields we use are required;
 *  the rest are present in the response but skipped here. */
interface LichessGame {
  id: string;
  rated?: boolean;
  variant?: string;
  speed?: 'ultraBullet' | 'bullet' | 'blitz' | 'rapid' | 'classical' | 'correspondence';
  perf?: string;
  createdAt?: number;
  lastMoveAt?: number;
  status?: string;
  winner?: 'white' | 'black';
  players?: {
    white?: { user?: { name?: string }; rating?: number };
    black?: { user?: { name?: string }; rating?: number };
  };
  moves?: string;
  opening?: { eco?: string };
}

/** Parse first N tokens from the space-separated `moves` field. Lichess
 *  returns clean SAN already (no comments, no NAGs, no result token). */
function firstNPlies(moves: string | undefined, n = MOVE_SEQ_PLY_COUNT): string {
  if (!moves) return '';
  const tokens = moves.trim().split(/\s+/);
  return tokens.slice(0, n).join(' ');
}

function countPlies(moves: string | undefined): number {
  if (!moves) return 0;
  return moves
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0).length;
}

function lichessToGameRow(game: LichessGame, targetHandle: string): GameRow | null {
  if (game.rated === false) return null;
  if (game.variant && game.variant !== 'standard') return null;
  const whiteName = game.players?.white?.user?.name?.toLowerCase() ?? '';
  const blackName = game.players?.black?.user?.name?.toLowerCase() ?? '';
  const target = targetHandle.toLowerCase();
  let color: 'white' | 'black';
  let opponentRating: number | null;
  if (whiteName === target) {
    color = 'white';
    opponentRating = game.players?.black?.rating ?? null;
  } else if (blackName === target) {
    color = 'black';
    opponentRating = game.players?.white?.rating ?? null;
  } else {
    return null;
  }

  // Result encoding: 1-0 if white won, 0-1 if black won, 1/2-1/2 if no winner.
  let result: '1-0' | '0-1' | '1/2-1/2';
  if (game.winner === 'white') result = '1-0';
  else if (game.winner === 'black') result = '0-1';
  else if (
    game.status === 'draw' ||
    game.status === 'stalemate' ||
    game.status === 'insufficientMaterialForVictory' ||
    !game.winner
  ) {
    result = '1/2-1/2';
  } else {
    return null;
  }

  // Drop ultraBullet (too noisy for fingerprinting) and correspondence.
  if (game.speed === 'ultraBullet' || game.speed === 'correspondence') return null;
  const timeClass = game.speed ?? null;

  const ts = game.lastMoveAt ?? game.createdAt;
  if (!ts) return null;
  const playedAt = new Date(ts);
  if (!Number.isFinite(playedAt.getTime())) return null;

  return {
    color,
    result,
    time_class: timeClass,
    opening_eco: game.opening?.eco ?? null,
    ply_count: countPlies(game.moves),
    termination: game.status ?? null,
    opponent_rating: opponentRating,
    played_at: playedAt,
    move_seq_prefix: firstNPlies(game.moves),
  };
}

/** Wrapper around the shared rate-limited Lichess client. Delegates to
 *  fetchUserGamesNdjson in apps/workers/src/lib/lichess-api.ts so we
 *  inherit its throttle (1.5s anon / 250ms authed) + 429/5xx exponential
 *  backoff retry + LICHESS_API_TOKEN auth. */
function streamUserGames(handle: string, maxGames: number): AsyncGenerator<LichessGame> {
  return fetchUserGamesNdjson<LichessGame>(
    handle,
    { max: maxGames, rated: true, perfType: 'bullet,blitz,rapid,classical' },
    { pgnInJson: 'false', clocks: 'false', evals: 'false', opening: 'true' },
  );
}

interface HandleResult {
  handle: string;
  gamesAccepted: number;
  gamesSeen: number;
  fingerprintWritten: boolean;
  skipReason: string | null;
  durationMs: number;
}

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

  const buffer: GameRow[] = [];
  try {
    for await (const game of streamUserGames(handle, args.maxGames)) {
      result.gamesSeen++;
      const row = lichessToGameRow(game, handle);
      if (row) buffer.push(row);
    }
  } catch (err) {
    result.skipReason = `error: ${err instanceof Error ? err.message : String(err)}`;
    result.durationMs = Date.now() - t0;
    return result;
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
  await writeFingerprint(cloudSql, handle, buffer.length, features, terms);
  result.fingerprintWritten = true;
  result.durationMs = Date.now() - t0;
  return result;
}

/** Upsert handles + style_features + account_fingerprints + fingerprint_terms.
 *  Mirror of the chess.com fast-lane writeFingerprint; platform is locked to
 *  'lichess'. Wrapped in sql.begin() so a partial failure can't leave a
 *  handle searchable in account_fingerprints but empty in fingerprint_terms. */
async function writeFingerprint(
  sql: postgres.Sql,
  handle: string,
  gamesWindow: number,
  features: PlayerFeaturesV0,
  terms: FingerprintTerm[],
): Promise<void> {
  const earliest = new Date(features.earliest_played_at);
  const latest = new Date(features.latest_played_at);
  const featuresJson = JSON.stringify(features);
  const dominantTc = argmaxKey(features.time_class);
  const whiteShare = features.games_total > 0 ? features.games_as_white / features.games_total : 0;
  const medianRating =
    features.avg_opponent_rating === null ? null : Math.round(features.avg_opponent_rating);

  await sql.begin(async (tx) => {
    const handleRows = await tx<{ id: string }[]>`
      INSERT INTO handles (platform, handle, games_seen, first_seen_at, last_seen_at)
      VALUES ('lichess', ${handle.toLowerCase()}, ${gamesWindow},
              ${earliest.toISOString()}, ${latest.toISOString()})
      ON CONFLICT (platform, handle) DO UPDATE SET
        games_seen = GREATEST(handles.games_seen, EXCLUDED.games_seen),
        first_seen_at = LEAST(handles.first_seen_at, EXCLUDED.first_seen_at),
        last_seen_at = GREATEST(handles.last_seen_at, EXCLUDED.last_seen_at)
      RETURNING id
    `;
    const handleId = handleRows[0]?.id;
    if (!handleId) throw new Error(`handles upsert returned no rows for lichess/${handle}`);

    await tx`
      INSERT INTO style_features (player_id, features, games_window)
      VALUES (${handleId}, ${featuresJson}, ${gamesWindow})
      ON CONFLICT (player_id) DO UPDATE SET
        features = EXCLUDED.features,
        games_window = EXCLUDED.games_window,
        computed_at = NOW()
    `;

    await tx`
      INSERT INTO account_fingerprints (
        handle_id, platform, handle, games_window,
        median_rating, dominant_time_class, white_share,
        earliest_played_at, latest_played_at, scalar_summary
      ) VALUES (
        ${handleId}, 'lichess', ${handle.toLowerCase()}, ${gamesWindow},
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

    await tx`DELETE FROM fingerprint_terms WHERE handle_id = ${handleId}`;
    if (terms.length > 0) {
      const insert = tx as unknown as (rs: object[], ...cs: string[]) => postgres.Helper<object[]>;
      const rows = terms.map((t) => ({
        handle_id: handleId,
        kind: t.kind,
        term: t.term,
        weight: t.weight,
      }));
      const CHUNK = 10000;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        await tx`
          INSERT INTO fingerprint_terms
            ${insert(chunk, 'handle_id', 'kind', 'term', 'weight')}
          ON CONFLICT (handle_id, kind, term) DO UPDATE SET
            weight = EXCLUDED.weight
        `;
      }
    }
  });
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

/** Lichess T1/T2/T3 cuts shifted up vs chess.com — Lichess ratings inflate.
 *  T1 ≈ FIDE 1400+, T2 ≈ FIDE 1200-1400, T3 ≈ FIDE 1000-1200. */
async function selectHandles(
  supaSql: postgres.Sql,
  tier: PriorityTier,
  maxHandles: number | null,
): Promise<string[]> {
  type Row = { handle: string };
  if (tier === 'T1') {
    const rows = maxHandles
      ? await supaSql<Row[]>`
          SELECT handle FROM platform_players
          WHERE platform = 'lichess'
            AND (
              COALESCE(rating_blitz, 0) >= 1900
              OR COALESCE(rating_rapid, 0) >= 1900
              OR title IS NOT NULL
              OR claimed_federation_player_id IS NOT NULL
              OR is_verified_oauth = true
            )
          ORDER BY first_seen_at ASC
          LIMIT ${maxHandles}`
      : await supaSql<Row[]>`
          SELECT handle FROM platform_players
          WHERE platform = 'lichess'
            AND (
              COALESCE(rating_blitz, 0) >= 1900
              OR COALESCE(rating_rapid, 0) >= 1900
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
          WHERE platform = 'lichess'
            AND title IS NULL
            AND (
              (rating_blitz BETWEEN 1700 AND 1899)
              OR (rating_rapid BETWEEN 1700 AND 1899)
            )
            AND NOT (
              COALESCE(rating_blitz, 0) >= 1900
              OR COALESCE(rating_rapid, 0) >= 1900
            )
          ORDER BY first_seen_at ASC
          LIMIT ${maxHandles}`
      : await supaSql<Row[]>`
          SELECT handle FROM platform_players
          WHERE platform = 'lichess'
            AND title IS NULL
            AND (
              (rating_blitz BETWEEN 1700 AND 1899)
              OR (rating_rapid BETWEEN 1700 AND 1899)
            )
            AND NOT (
              COALESCE(rating_blitz, 0) >= 1900
              OR COALESCE(rating_rapid, 0) >= 1900
            )
          ORDER BY first_seen_at ASC`;
    return rows.map((r) => r.handle.toLowerCase());
  }
  // T3
  const rows = maxHandles
    ? await supaSql<Row[]>`
        SELECT handle FROM platform_players
        WHERE platform = 'lichess'
          AND title IS NULL
          AND (
            (rating_blitz BETWEEN 1400 AND 1699)
            OR (rating_rapid BETWEEN 1400 AND 1699)
          )
          AND NOT (
            COALESCE(rating_blitz, 0) >= 1700
            OR COALESCE(rating_rapid, 0) >= 1700
          )
        ORDER BY first_seen_at ASC
        LIMIT ${maxHandles}`
    : await supaSql<Row[]>`
        SELECT handle FROM platform_players
        WHERE platform = 'lichess'
          AND title IS NULL
          AND (
            (rating_blitz BETWEEN 1400 AND 1699)
            OR (rating_rapid BETWEEN 1400 AND 1699)
          )
          AND NOT (
            COALESCE(rating_blitz, 0) >= 1700
            OR COALESCE(rating_rapid, 0) >= 1700
          )
        ORDER BY first_seen_at ASC`;
  return rows.map((r) => r.handle.toLowerCase());
}

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
  const hasToken = Boolean(process.env.LICHESS_API_TOKEN);
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
        `[fast-lane-lichess] tier=${args.tier} → ${fmt(handles.length)} handles ` +
          `(max-games=${args.maxGames}, concurrency=${args.concurrency}, ` +
          `min-games=${args.minGames}, token=${hasToken ? 'yes' : 'no'}` +
          `${args.dryRun ? ', DRY RUN' : ''})`,
      );
    } else {
      throw new Error('unreachable');
    }

    if (handles.length === 0) {
      console.log('[fast-lane-lichess] no handles to process.');
      return;
    }

    const t0 = Date.now();
    const results = await runPool(cloudSql, handles, args);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);

    const wrote = results.filter((r) => r.fingerprintWritten).length;
    const skipped = results.filter((r) => !r.fingerprintWritten).length;
    const totalGames = results.reduce((s, r) => s + r.gamesAccepted, 0);
    console.log(`\n[fast-lane-lichess] DONE in ${dt}s`);
    console.log(`  handles processed: ${fmt(results.length)}`);
    console.log(`  fingerprints written: ${fmt(wrote)}`);
    console.log(`  skipped: ${fmt(skipped)}`);
    console.log(`  total games accepted: ${fmt(totalGames)}`);

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

/**
 * One-handle Lichess fast-lane fingerprint run. Mirror of the chess.com
 * variant in fast-lane.ts — used by the on-link Inngest function so a
 * freshly OAuth-linked Lichess account gets its fingerprint built without
 * waiting for the next tier-wide batch.
 */
export interface FastLaneLichessOneResult {
  handle: string;
  gamesAccepted: number;
  gamesSeen: number;
  fingerprintWritten: boolean;
  skipReason: string | null;
  durationMs: number;
}

export async function runLichessFingerprintOne(
  handle: string,
  opts: { maxGames?: number; minGames?: number; dryRun?: boolean } = {},
): Promise<FastLaneLichessOneResult> {
  const args: CliArgs = {
    handle: handle.toLowerCase(),
    tier: null,
    maxHandles: null,
    maxGames: opts.maxGames ?? DEFAULT_MAX_GAMES,
    concurrency: 1,
    minGames: opts.minGames ?? DEFAULT_MIN_GAMES,
    dryRun: opts.dryRun ?? false,
  };
  const { client: cloudSql } = getGamesDb();
  try {
    return await processHandle(cloudSql, handle.toLowerCase(), args);
  } finally {
    await cloudSql.end({ timeout: 5 });
  }
}

const isCliInvocation =
  process.argv[1]?.endsWith('fast-lane-lichess.ts') ||
  process.argv[1]?.endsWith('fast-lane-lichess.js');

if (isCliInvocation) {
  main().catch((err) => {
    console.error('fast-lane-lichess worker failed:', err);
    process.exit(1);
  });
}
