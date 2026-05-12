/**
 * Chess.com PubAPI helpers.
 *
 * No OAuth — Chess.com's public API is anonymous-readable. We verify
 * ownership of a handle by issuing a one-time token, asking the user to
 * paste it into their chess.com profile location/bio, then fetching
 * their profile and checking that the token appears.
 *
 * https://www.chess.com/news/view/published-data-api
 */

export const CHESSCOM_API_BASE = 'https://api.chess.com/pub';

/** User-Agent is required by chess.com PubAPI; without it requests get 403. */
const USER_AGENT = 'chessco/0.1 (+https://chessco.org)';

export type ChesscomPlayer = {
  '@id': string;
  url: string;
  username: string;
  player_id: number;
  title?: string;
  status: string;
  name?: string;
  avatar?: string;
  location?: string;
  country?: string; // URL to country resource
  joined: number;
  last_online: number;
  followers: number;
  is_streamer?: boolean;
};

export type ChesscomStats = {
  chess_bullet?: { last?: { rating: number } };
  chess_blitz?: { last?: { rating: number } };
  chess_rapid?: { last?: { rating: number } };
  chess_daily?: { last?: { rating: number } };
};

export async function fetchChesscomPlayer(handle: string): Promise<ChesscomPlayer> {
  const normalized = handle.trim().toLowerCase();
  const res = await fetch(`${CHESSCOM_API_BASE}/player/${encodeURIComponent(normalized)}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    cache: 'no-store',
  });
  if (res.status === 404) {
    throw new Error(`Chess.com handle "${normalized}" not found.`);
  }
  if (!res.ok) {
    throw new Error(`Chess.com player fetch failed: ${res.status}`);
  }
  return (await res.json()) as ChesscomPlayer;
}

export async function fetchChesscomStats(handle: string): Promise<ChesscomStats> {
  const normalized = handle.trim().toLowerCase();
  const res = await fetch(`${CHESSCOM_API_BASE}/player/${encodeURIComponent(normalized)}/stats`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Chess.com stats fetch failed: ${res.status}`);
  }
  return (await res.json()) as ChesscomStats;
}

export function chesscomRatings(stats: ChesscomStats): {
  rating_bullet?: number;
  rating_blitz?: number;
  rating_rapid?: number;
  rating_classical?: number;
} {
  return {
    rating_bullet: stats.chess_bullet?.last?.rating,
    rating_blitz: stats.chess_blitz?.last?.rating,
    rating_rapid: stats.chess_rapid?.last?.rating,
    // chess.com doesn't have a "classical" pool; map daily → classical as the
    // long time-control equivalent. We don't show this as "classical" anywhere
    // public — it's just for our internal rating-band correlation later.
    rating_classical: stats.chess_daily?.last?.rating,
  };
}

/**
 * Check whether the chess.com profile contains a given verification token
 * anywhere in the visible bio/location/name fields. Case-insensitive.
 */
export function profileContainsToken(player: ChesscomPlayer, token: string): boolean {
  const t = token.toLowerCase();
  const haystacks = [player.location, player.name, player.username, player.url].filter(
    (x): x is string => typeof x === 'string',
  );
  return haystacks.some((h) => h.toLowerCase().includes(t));
}
