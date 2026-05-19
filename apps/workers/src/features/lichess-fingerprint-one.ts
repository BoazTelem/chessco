/**
 * Per-user Lichess fingerprint — single API call, on-demand.
 *
 * Used by the `account.linked.lichess` Inngest function when a user
 * verifies their Lichess account: one round-trip to
 * GET /api/games/user/{username}?max=N (ndjson, opening tags), build
 * style_features + account_fingerprints + fingerprint_terms in one
 * transaction. No queue, no bulk loop, no opponent discovery.
 *
 * This is explicitly NOT bulk enumeration — Thomas at Lichess
 * (contact@lichess.org, 2026-05-18) confirmed per-user single calls are
 * fine; only looping through thousands of handles via this endpoint is
 * disallowed. See [docs/INCIDENT-2026-05-18-lichess-ip-block.md].
 *
 * The old apps/workers/src/features/fast-lane-lichess.ts had both this
 * single-user path AND a tier-wide bulk CLI. The bulk CLI was the
 * anti-pattern and was deleted; this file is the surviving, legitimate
 * subset.
 */
import { getGamesDb } from '../db';
import { fetchUserGamesNdjson } from '../lib/lichess-api';
import {
  extractFeaturesV0,
  extractFingerprintTerms,
  type FingerprintTerm,
  type GameRow,
} from './extract';
import type { PlayerFeaturesV0 } from './types';
import type postgres from 'postgres';

const DEFAULT_MAX_GAMES = 1000;
const DEFAULT_MIN_GAMES = 10;
const MOVE_SEQ_PLY_COUNT = 12;

export interface LichessFingerprintOneResult {
  handle: string;
  gamesAccepted: number;
  gamesSeen: number;
  fingerprintWritten: boolean;
  skipReason: string | null;
  durationMs: number;
}

/** One Lichess game from /api/games/user ndjson. Required fields only. */
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

function firstNPlies(moves: string | undefined, n = MOVE_SEQ_PLY_COUNT): string {
  if (!moves) return '';
  return moves.trim().split(/\s+/).slice(0, n).join(' ');
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

function streamUserGames(handle: string, maxGames: number): AsyncGenerator<LichessGame> {
  return fetchUserGamesNdjson<LichessGame>(
    handle,
    { max: maxGames, rated: true, perfType: 'bullet,blitz,rapid,classical' },
    { pgnInJson: 'false', clocks: 'false', evals: 'false', opening: 'true' },
  );
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

export async function runLichessFingerprintOne(
  handle: string,
  opts: { maxGames?: number; minGames?: number; dryRun?: boolean } = {},
): Promise<LichessFingerprintOneResult> {
  const maxGames = opts.maxGames ?? DEFAULT_MAX_GAMES;
  const minGames = opts.minGames ?? DEFAULT_MIN_GAMES;
  const dryRun = opts.dryRun ?? false;
  const target = handle.toLowerCase();
  const t0 = Date.now();

  const result: LichessFingerprintOneResult = {
    handle: target,
    gamesAccepted: 0,
    gamesSeen: 0,
    fingerprintWritten: false,
    skipReason: null,
    durationMs: 0,
  };

  const buffer: GameRow[] = [];
  try {
    for await (const game of streamUserGames(target, maxGames)) {
      result.gamesSeen++;
      const row = lichessToGameRow(game, target);
      if (row) buffer.push(row);
    }
  } catch (err) {
    result.skipReason = `error: ${err instanceof Error ? err.message : String(err)}`;
    result.durationMs = Date.now() - t0;
    return result;
  }
  result.gamesAccepted = buffer.length;

  if (buffer.length < minGames) {
    result.skipReason = `${buffer.length} games < ${minGames} minimum`;
    result.durationMs = Date.now() - t0;
    return result;
  }
  if (dryRun) {
    result.skipReason = 'dry-run';
    result.durationMs = Date.now() - t0;
    return result;
  }

  const { client: cloudSql } = getGamesDb();
  try {
    const features = extractFeaturesV0(buffer);
    const terms = extractFingerprintTerms(features);
    await writeFingerprint(cloudSql, target, buffer.length, features, terms);
    result.fingerprintWritten = true;
  } finally {
    await cloudSql.end({ timeout: 5 });
  }
  result.durationMs = Date.now() - t0;
  return result;
}
