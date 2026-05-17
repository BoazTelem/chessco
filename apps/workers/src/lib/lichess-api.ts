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

/** Optional Lichess personal API token (created at
 *  lichess.org/account/oauth/token/create). When set, we send it as a
 *  Bearer header and Lichess raises the rate cap from ~30 req/min to
 *  ~300 req/min for the user-export endpoint. No scope required for
 *  public games. */
const LICHESS_API_TOKEN = process.env.LICHESS_API_TOKEN ?? null;

/** Inner gap differs by auth mode:
 *  - Anonymous: 1500ms (Lichess docs ask for >=1s on user-export)
 *  - Authenticated: 250ms (4 req/sec; well under the 5 req/sec
 *    authenticated tier, leaves headroom for bursts). */
const MIN_REQUEST_GAP_MS = LICHESS_API_TOKEN ? 250 : 1500;
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
  /** Hard cap on games returned (most-recent first). Default: unlimited. */
  max?: number;
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
      const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        Accept: 'application/x-chess-pgn',
      };
      if (LICHESS_API_TOKEN) headers.Authorization = `Bearer ${LICHESS_API_TOKEN}`;
      res = await fetch(url, { headers });
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
 * GET /api/games/user/{username} with Accept: application/x-ndjson.
 *
 * Same throttle + retry semantics as fetchUserGamesPgn, but returns each
 * game as a structured JSON line rather than concatenated PGN text. Caller
 * iterates the returned async generator to consume one game at a time.
 *
 * Useful for fingerprinting where we want structured per-game fields
 * (white/black rating, opening eco, moves) without re-parsing PGN. The
 * fast-lane Lichess worker uses this; the per-handle dump crawler still
 * uses fetchUserGamesPgn so it can pipe into shared streamGames.
 *
 * Yields nothing on 404 (handle not found / banned / closed) — caller
 * gets an empty stream, not an error.
 *
 * NDJSON-shape isn't fully typed here; callers narrow to their own type.
 */
export async function* fetchUserGamesNdjson<T>(
  handle: string,
  query: UserGamesQuery = {},
  // Lichess /api/games/user supports pgnInJson / clocks / evals / opening
  // toggles in addition to the shared UserGamesQuery — pass them via this
  // bag so callers don't pay for fields they won't use.
  extraQuery: Record<string, string> = {},
): AsyncGenerator<T> {
  const params = new URLSearchParams();
  if (query.sinceMs !== undefined) params.set('since', String(query.sinceMs));
  if (query.untilMs !== undefined) params.set('until', String(query.untilMs));
  if (query.max !== undefined) params.set('max', String(query.max));
  params.set('rated', query.rated === false ? 'false' : 'true');
  params.set('perfType', query.perfType ?? 'bullet,blitz,rapid,classical');
  for (const [k, v] of Object.entries(extraQuery)) params.set(k, v);
  const url = `${LICHESS_API_BASE}/games/user/${encodeURIComponent(handle.toLowerCase())}?${params.toString()}`;

  let lastErr: Error | null = null;
  let body: ReadableStream<Uint8Array> | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) await backoff(attempt);
    await rateLimitGap();

    let res: Response;
    try {
      const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        Accept: 'application/x-ndjson',
      };
      if (LICHESS_API_TOKEN) headers.Authorization = `Bearer ${LICHESS_API_TOKEN}`;
      res = await fetch(url, { headers });
    } catch (err) {
      lastErr = err as Error;
      continue;
    }

    if (res.status === 404) return;
    if (res.status === 429 || res.status >= 500) {
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
    body = res.body;
    break;
  }
  if (!body) throw lastErr ?? new Error(`fetchUserGamesNdjson(${url}): exhausted retries`);

  // Stream ndjson body line-by-line. Buffer between chunks until newline.
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.length > 0) {
        try {
          yield JSON.parse(line) as T;
        } catch {
          // Skip malformed lines; Lichess sometimes ships partials on
          // connection drops that we can safely ignore.
        }
      }
      nl = buf.indexOf('\n');
    }
    if (done) break;
  }
  if (buf.trim().length > 0) {
    try {
      yield JSON.parse(buf) as T;
    } catch {
      // ignore trailing partial
    }
  }
}

/**
 * POST /api/users — bulk-check a batch of handles (max 300 per request,
 * per Lichess docs). Returns the array of live user profiles; dead /
 * banned / closed handles are simply omitted from the response.
 *
 * Same throttle + retry semantics as the other endpoints in this module:
 * 1.5s anon / 250ms authed inner gap, 1s → 30s exponential backoff on
 * 429 / 5xx, up to MAX_RETRIES attempts.
 *
 * Returns empty array on 404 (unlikely on this endpoint).
 *
 * Caller narrows the response shape via the generic T — typed Lichess
 * user response shapes vary by what fields the caller cares about.
 */
export async function fetchLichessUserBulk<T>(handles: string[]): Promise<T[]> {
  if (handles.length === 0) return [];
  if (handles.length > 300) {
    throw new Error(`fetchLichessUserBulk: max 300 handles per request (got ${handles.length})`);
  }
  const url = `${LICHESS_API_BASE}/users`;
  const body = handles.join(',');

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) await backoff(attempt);
    await rateLimitGap();

    let res: Response;
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'text/plain',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      };
      if (LICHESS_API_TOKEN) headers.Authorization = `Bearer ${LICHESS_API_TOKEN}`;
      res = await fetch(url, { method: 'POST', headers, body });
    } catch (err) {
      lastErr = err as Error;
      continue;
    }

    if (res.status === 404) return [];
    if (res.status === 429 || res.status >= 500) {
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
    return (await res.json()) as T[];
  }
  throw lastErr ?? new Error(`fetchLichessUserBulk(${url}): exhausted retries`);
}

/**
 * Lichess time-class buckets that have a top-N leaderboard.
 * Note: Lichess deprecated /api/users/titled (404 as of 2026), so per-perf
 * top-N is the only public top-down seed source left.
 */
export const LICHESS_TOP_PERFS = [
  'bullet',
  'blitz',
  'rapid',
  'classical',
  'ultraBullet',
  'chess960',
  'crazyhouse',
  'kingOfTheHill',
] as const;
export type LichessTopPerf = (typeof LICHESS_TOP_PERFS)[number];

/**
 * GET /api/player/top/{nb}/{perfType} — top-N rated handles for a perf.
 * Each per-perf response is a `{ users: [{ id, username, title?, perfs }] }`
 * object. Returns lowercased ids in rank order (highest rating first).
 *
 * Lichess caps `nb` at 200 per request.
 */
export async function fetchTopLichessHandles(perf: LichessTopPerf, nb = 200): Promise<string[]> {
  if (nb < 1 || nb > 200) {
    throw new Error(`fetchTopLichessHandles: nb must be 1..200 (got ${nb})`);
  }
  const url = `${LICHESS_API_BASE}/player/top/${nb}/${perf}`;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) await backoff(attempt);
    await rateLimitGap();
    let res: Response;
    try {
      const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        Accept: 'application/vnd.lichess.v3+json',
      };
      if (LICHESS_API_TOKEN) headers.Authorization = `Bearer ${LICHESS_API_TOKEN}`;
      res = await fetch(url, { headers });
    } catch (err) {
      lastErr = err as Error;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
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
    const body = (await res.json()) as { users?: Array<{ id?: string; username?: string }> };
    return (body.users ?? [])
      .map((u) => (u.id ?? u.username ?? '').toLowerCase())
      .filter((h) => h.length > 0);
  }
  throw lastErr ?? new Error(`fetchTopLichessHandles(${url}): exhausted retries`);
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
