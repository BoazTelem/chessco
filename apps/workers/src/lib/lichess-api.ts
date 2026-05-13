/**
 * Lichess public API client for the per-handle crawler.
 *
 * Sibling of apps/workers/src/lib/chesscom-api.ts. Differences:
 *  - Lichess user-game-export returns a single streamed PGN response
 *    covering the requested window — no per-month split. We return a
 *    Node Readable so streamGames can iterate without buffering.
 *  - Lichess is stricter than chess.com on this endpoint specifically,
 *    so inner self-throttle defaults to 1500ms.
 *  - Authentication is optional. Anonymous works for public games at
 *    the rate we run. OAuth token integration is out of scope for MVP.
 *
 * https://lichess.org/api#tag/Games/operation/apiGamesUser
 */

import { Readable } from 'node:stream';

export const LICHESS_API_BASE = 'https://lichess.org/api';
const USER_AGENT = 'chessco-worker/0.1 (+https://chessco.org)';

/** Conservative inner gap. Lichess docs ask for at least ~1s on this
 *  endpoint when anonymous; we add headroom. The outer crawler loop's
 *  --rate-ms sits on top of this. */
const MIN_REQUEST_GAP_MS = 1500;
const MAX_RETRIES = 5;

let lastRequestAt = 0;

async function rateLimitGap(): Promise<void> {
  const wait = MIN_REQUEST_GAP_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

async function backoff(attempt: number): Promise<void> {
  // 1s, 2s, 4s, 8s, 16s — capped at 30s.
  const ms = Math.min(1000 * 2 ** attempt, 30_000);
  await new Promise((r) => setTimeout(r, ms));
}

export class LichessApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
  ) {
    super(message);
    this.name = 'LichessApiError';
  }
}

export interface UserGamesQuery {
  /** Unix-ms inclusive lower bound on game end_time. */
  sinceMs?: number;
  /** Unix-ms inclusive upper bound. */
  untilMs?: number;
  /** Default: true. Skip casual games. */
  rated?: boolean;
  /** Comma-separated time classes. Default: 'bullet,blitz,rapid,classical'. */
  perfType?: string;
}

/**
 * GET /api/games/user/{username} as a streaming PGN response.
 *
 * Returns a Node Readable carrying utf-8 PGN text, suitable for
 * passing into `streamGames` from lichess-dumps/pgn-stream.ts.
 *
 * Returns null on 404 (handle not found / banned / closed).
 * Throws LichessApiError on persistent 5xx after retries.
 * Retries 429s with exponential backoff before throwing.
 */
export async function fetchUserGamesPgn(
  handle: string,
  query: UserGamesQuery = {},
): Promise<Readable | null> {
  const params = new URLSearchParams();
  if (query.sinceMs !== undefined) params.set('since', String(query.sinceMs));
  if (query.untilMs !== undefined) params.set('until', String(query.untilMs));
  params.set('rated', query.rated === false ? 'false' : 'true');
  params.set('perfType', query.perfType ?? 'bullet,blitz,rapid,classical');
  // Default response is PGN. Be explicit.
  const url = `${LICHESS_API_BASE}/games/user/${encodeURIComponent(handle.toLowerCase())}?${params.toString()}`;

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) await backoff(attempt);
    await rateLimitGap();

    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/x-chess-pgn',
        },
      });
    } catch (err) {
      lastErr = err as Error;
      continue;
    }

    if (res.status === 404) return null;
    if (res.status === 429 || res.status >= 500) {
      // Drain body so the connection can be reused on retry.
      try {
        await res.body?.cancel();
      } catch {
        // ignore
      }
      lastErr = new LichessApiError(`${res.status} ${res.statusText}`, res.status, url);
      continue;
    }
    if (!res.ok) {
      throw new LichessApiError(`${res.status} ${res.statusText}`, res.status, url);
    }
    if (!res.body) {
      throw new LichessApiError('empty body', res.status, url);
    }
    // Convert web ReadableStream to Node Readable so streamGames can
    // iterate it. Node 18+ supports this conversion natively.
    return Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
  }
  throw lastErr ?? new Error(`fetchUserGamesPgn(${url}): exhausted retries`);
}

/**
 * Compute (sinceMs, untilMs) for "last N months from now".
 */
export function monthsBackWindow(
  monthsBack: number,
  now: Date = new Date(),
): {
  sinceMs: number;
  untilMs: number;
} {
  const untilMs = now.getTime();
  const since = new Date(now);
  since.setMonth(since.getMonth() - monthsBack);
  return { sinceMs: since.getTime(), untilMs };
}
