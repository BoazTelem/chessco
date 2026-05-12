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
  /** Country ISO when known (lichess profile.country / chess.com country URL tail). */
  country?: string | null;
  title?: string | null;
  ratings?: {
    bullet?: number;
    blitz?: number;
    rapid?: number;
    classical?: number;
  };
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
    profile?: { country?: string };
    disabled?: boolean;
    closed?: boolean;
  };
  if (u.disabled || u.closed) {
    negativeCache.set(cacheKey, true);
    return { platform: 'lichess', handle: lower, exists: false };
  }
  return {
    platform: 'lichess',
    handle: lower,
    exists: true,
    country: u.profile?.country?.toUpperCase() ?? null,
    title: u.title ?? null,
    ratings: {
      bullet: u.perfs?.bullet?.rating,
      blitz: u.perfs?.blitz?.rating,
      rapid: u.perfs?.rapid?.rating,
      classical: u.perfs?.classical?.rating,
    },
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
  return {
    platform: 'chess.com',
    handle: lower,
    exists: true,
    country: isoFromCountryUrl(player.country),
    title: player.title ?? null,
    ratings: {
      bullet: stats?.chess_bullet?.last?.rating,
      blitz: stats?.chess_blitz?.last?.rating,
      rapid: stats?.chess_rapid?.last?.rating,
      classical: stats?.chess_daily?.last?.rating,
    },
    raw: { player, stats },
  };
}
