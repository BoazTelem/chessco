/**
 * Probe Lichess + chess.com to see if a hypothesized handle exists.
 *
 * On 200 OK, we capture the profile + ratings and return them for
 * upsertion into platform_players. On 404, we cache the negative result
 * in-process so the same Stage 2 run doesn't re-probe.
 *
 * Rate-limited inside chesscom-api.ts (100ms gap). Lichess does its
 * own throttling but is generous on /api/user/{u}.
 */
import { fetchPlayer, fetchPlayerStats, isoFromCountryUrl } from '../lib/chesscom-api';

const LICHESS_USER_AGENT = 'chessco-worker/0.1 (+https://chessco.org)';
const LICHESS_MIN_GAP_MS = 100;
let lichessLastReqAt = 0;

export type ProbePlatform = 'lichess' | 'chess.com';

export interface ProbeResult {
  platform: ProbePlatform;
  handle: string;
  exists: boolean;
  /** Crawler-derived country ISO (lichess profile.country / chess.com country
   *  URL tail). Mapped to platform_players.country in the upsert. */
  country?: string | null;
  title?: string | null;
  ratings?: {
    bullet?: number;
    blitz?: number;
    rapid?: number;
    classical?: number;
  };
  /** Self-reported FIDE rating from the player's bio. Lichess
   *  profile.fideRating / chess.com .fide. Stored in
   *  platform_players.claimed_fide_rating (migration 0049). Stage 2 uses
   *  this as a sharper rating signal than the online-rating ± offset
   *  heuristic when present. */
  claimed_fide_rating?: number | null;
  /** Self-reported country (separate column from `country` since the two
   *  signals can disagree — `country` is canonical/crawler-derived,
   *  `claimed_country` is the player's bio). Maps to
   *  platform_players.claimed_country (migration 0049). */
  claimed_country?: string | null;
  /** Raw response payload (truncated upstream) — for upsert.raw column. */
  raw?: unknown;
}

const negativeCache = new Map<string, true>();

function neg(platform: ProbePlatform, handle: string): string {
  return `${platform}:${handle.toLowerCase()}`;
}

/** GET /api/user/{handle} on Lichess. 404 → null. */
export async function probeLichess(handle: string): Promise<ProbeResult> {
  const lower = handle.toLowerCase();
  const cacheKey = neg('lichess', lower);
  if (negativeCache.has(cacheKey)) {
    return { platform: 'lichess', handle: lower, exists: false };
  }

  const gap = LICHESS_MIN_GAP_MS - (Date.now() - lichessLastReqAt);
  if (gap > 0) await new Promise((r) => setTimeout(r, gap));
  lichessLastReqAt = Date.now();

  const res = await fetch(`https://lichess.org/api/user/${encodeURIComponent(lower)}`, {
    headers: { 'User-Agent': LICHESS_USER_AGENT, Accept: 'application/json' },
  });
  if (res.status === 404) {
    negativeCache.set(cacheKey, true);
    return { platform: 'lichess', handle: lower, exists: false };
  }
  if (!res.ok) {
    throw new Error(`Lichess probe ${lower}: ${res.status} ${res.statusText}`);
  }
  const u = (await res.json()) as {
    id?: string;
    username?: string;
    title?: string;
    perfs?: {
      bullet?: { rating: number };
      blitz?: { rating: number };
      rapid?: { rating: number };
      classical?: { rating: number };
    };
    profile?: { country?: string; fideRating?: number };
    disabled?: boolean;
    closed?: boolean;
  };
  if (u.disabled || u.closed) {
    negativeCache.set(cacheKey, true);
    return { platform: 'lichess', handle: lower, exists: false };
  }
  const lichessCountry = u.profile?.country?.toUpperCase() ?? null;
  return {
    platform: 'lichess',
    handle: lower,
    exists: true,
    country: lichessCountry,
    title: u.title ?? null,
    ratings: {
      bullet: u.perfs?.bullet?.rating,
      blitz: u.perfs?.blitz?.rating,
      rapid: u.perfs?.rapid?.rating,
      classical: u.perfs?.classical?.rating,
    },
    // Lichess exposes the self-reported FIDE rating on profile.fideRating;
    // a value of 0 (or missing) means the player didn't fill it in. We
    // surface it on platform_players.claimed_fide_rating for Stage 2.
    claimed_fide_rating:
      typeof u.profile?.fideRating === 'number' && u.profile.fideRating > 0
        ? u.profile.fideRating
        : null,
    claimed_country: lichessCountry,
    raw: u,
  };
}

/** GET /pub/player/{handle} + /stats on chess.com. 404 → null. */
export async function probeChesscom(handle: string): Promise<ProbeResult> {
  const lower = handle.toLowerCase();
  const cacheKey = neg('chess.com', lower);
  if (negativeCache.has(cacheKey)) {
    return { platform: 'chess.com', handle: lower, exists: false };
  }

  const player = await fetchPlayer(lower);
  if (!player) {
    negativeCache.set(cacheKey, true);
    return { platform: 'chess.com', handle: lower, exists: false };
  }
  const stats = await fetchPlayerStats(lower);
  const chesscomCountry = isoFromCountryUrl(player.country);
  return {
    platform: 'chess.com',
    handle: lower,
    exists: true,
    country: chesscomCountry,
    title: player.title ?? null,
    ratings: {
      bullet: stats?.chess_bullet?.last?.rating,
      blitz: stats?.chess_blitz?.last?.rating,
      rapid: stats?.chess_rapid?.last?.rating,
      classical: stats?.chess_daily?.last?.rating,
    },
    // chess.com /pub/player exposes player.fide (integer rating); 0 / missing
    // = player didn't enter it. Mirrors the upsert path in
    // apps/workers/src/chesscom-titled/upsert.ts.
    claimed_fide_rating: typeof player.fide === 'number' && player.fide > 0 ? player.fide : null,
    claimed_country: chesscomCountry,
    raw: { player, stats },
  };
}
