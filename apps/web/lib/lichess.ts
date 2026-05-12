/**
 * Lichess API helpers + OAuth PKCE configuration.
 *
 * Lichess uses public OAuth (no client secret) — we identify our app with
 * the `client_id` string only. Verification is via PKCE.
 *
 * https://lichess.org/api#section/Introduction/Authentication
 */

import { createHash, randomBytes } from 'node:crypto';

export const LICHESS_OAUTH_AUTHORIZE_URL = 'https://lichess.org/oauth';
export const LICHESS_OAUTH_TOKEN_URL = 'https://lichess.org/api/token';
export const LICHESS_API_BASE = 'https://lichess.org/api';

/** Client identifier shown to users on Lichess's consent screen. */
export const LICHESS_CLIENT_ID = 'chessco-web';

/** Random URL-safe string for PKCE code_verifier and state. */
export function randomToken(bytes = 32): string {
  return base64Url(randomBytes(bytes));
}

/** PKCE S256 challenge from a verifier. */
export function codeChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest());
}

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export type LichessAccount = {
  id: string;
  username: string;
  perfs?: Record<
    string,
    { rating?: number; rd?: number; prog?: number; games?: number; prov?: boolean }
  >;
  profile?: { country?: string };
};

export async function fetchLichessAccount(accessToken: string): Promise<LichessAccount> {
  const res = await fetch(`${LICHESS_API_BASE}/account`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Lichess /api/account failed: ${res.status}`);
  }
  return (await res.json()) as LichessAccount;
}

/**
 * Extract rating per time class from a Lichess /account response.
 * Lichess perf keys: bullet, blitz, rapid, classical, correspondence, ...
 */
export function lichessRatings(account: LichessAccount): {
  rating_bullet?: number;
  rating_blitz?: number;
  rating_rapid?: number;
  rating_classical?: number;
} {
  const perfs = account.perfs ?? {};
  return {
    rating_bullet: ratingOf(perfs.bullet),
    rating_blitz: ratingOf(perfs.blitz),
    rating_rapid: ratingOf(perfs.rapid),
    rating_classical: ratingOf(perfs.classical),
  };
}

function ratingOf(p?: { rating?: number; prov?: boolean }): number | undefined {
  if (!p || p.rating === undefined) return undefined;
  // Skip provisional ratings — they're noisy until ~20 games.
  if (p.prov) return undefined;
  return p.rating;
}
