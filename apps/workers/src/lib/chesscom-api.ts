/**
 * Chess.com Published Data API client for bulk crawling workers.
 *
 * Adds, beyond apps/web/lib/chesscom.ts:
 *   - rate limiting (Chess.com /pub is unauthenticated — we self-throttle
 *     to ~1 req/100ms = 10 rps; the docs ask politely and 429s are real)
 *   - exponential backoff on 429 / 5xx
 *   - typed helpers for /pub/titled-players/{title} and /pub/country/{ISO}/players
 *
 * https://www.chess.com/news/view/published-data-api
 */

export const CHESSCOM_API_BASE = 'https://api.chess.com/pub';

const USER_AGENT = 'chessco-worker/0.1 (+https://chessco.org)';
const MIN_REQUEST_GAP_MS = 100;
const MAX_RETRIES = 5;

let lastRequestAt = 0;

async function rateLimitGap(): Promise<void> {
  const wait = MIN_REQUEST_GAP_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

async function backoff(attempt: number): Promise<void> {
  // 500ms, 1s, 2s, 4s, 8s — capped.
  const ms = Math.min(500 * 2 ** attempt, 8000);
  await new Promise((r) => setTimeout(r, ms));
}

export class ChesscomApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
  ) {
    super(message);
    this.name = 'ChesscomApiError';
  }
}

/** GET a /pub URL as JSON, retrying on 429 / 5xx. 404 returns null. */
export async function fetchJson<T>(path: string): Promise<T | null> {
  const url = path.startsWith('http') ? path : `${CHESSCOM_API_BASE}${path}`;

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) await backoff(attempt);
    await rateLimitGap();

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
    } catch (err) {
      lastErr = err as Error;
      continue;
    }

    if (res.status === 404) return null;
    if (res.status === 429 || res.status >= 500) {
      lastErr = new ChesscomApiError(`${res.status} ${res.statusText}`, res.status, url);
      continue;
    }
    if (!res.ok) {
      throw new ChesscomApiError(`${res.status} ${res.statusText}`, res.status, url);
    }
    return (await res.json()) as T;
  }
  throw lastErr ?? new Error(`fetchJson(${url}): exhausted retries`);
}

// ============================================================================
// Typed endpoints
// ============================================================================

/** /pub/titled/{TITLE} → { players: string[] } (lowercased usernames). */
export interface TitledList {
  players: string[];
}

export async function fetchTitledList(title: ChesscomTitle): Promise<string[]> {
  const data = await fetchJson<TitledList>(`/titled/${title}`);
  return data?.players ?? [];
}

export type ChesscomTitle =
  | 'GM'
  | 'WGM'
  | 'IM'
  | 'WIM'
  | 'FM'
  | 'WFM'
  | 'NM'
  | 'WNM'
  | 'CM'
  | 'WCM';

export const ALL_TITLES: ChesscomTitle[] = [
  'GM',
  'WGM',
  'IM',
  'WIM',
  'FM',
  'WFM',
  'NM',
  'WNM',
  'CM',
  'WCM',
];

/** /pub/country/{ISO}/players → { players: string[] } */
export async function fetchCountryPlayers(iso: string): Promise<string[]> {
  const data = await fetchJson<{ players: string[] }>(`/country/${iso.toUpperCase()}/players`);
  return data?.players ?? [];
}

/** /pub/player/{username} → ChesscomPlayer */
export interface ChesscomPlayer {
  '@id': string;
  url: string;
  username: string;
  player_id: number;
  title?: string;
  status: string;
  name?: string;
  location?: string;
  country?: string;
  joined?: number;
  last_online?: number;
  followers?: number;
  /** Self-reported FIDE rating from the player's bio. When present, this
   *  is a far sharper Stage 2 signal than online-rating-vs-FIDE offset
   *  heuristics — surfaced as platform_players.claimed_fide_rating
   *  (migration 0049). */
  fide?: number;
}

export async function fetchPlayer(handle: string): Promise<ChesscomPlayer | null> {
  return fetchJson<ChesscomPlayer>(`/player/${encodeURIComponent(handle.toLowerCase())}`);
}

/** /pub/player/{username}/stats — rating snapshot. */
export interface ChesscomStats {
  chess_bullet?: { last?: { rating: number } };
  chess_blitz?: { last?: { rating: number } };
  chess_rapid?: { last?: { rating: number } };
  chess_daily?: { last?: { rating: number } };
}

export async function fetchPlayerStats(handle: string): Promise<ChesscomStats | null> {
  return fetchJson<ChesscomStats>(`/player/${encodeURIComponent(handle.toLowerCase())}/stats`);
}

/**
 * Country code lives at the end of the country URL ('.../pub/country/IL'). The
 * raw player payload uses the full URL — extract just the ISO code.
 */
export function isoFromCountryUrl(url: string | undefined): string | null {
  if (!url) return null;
  const m = /\/country\/([A-Z]{2,3})$/.exec(url);
  return m?.[1] ?? null;
}

// ============================================================================
// Games archives (used by the crawler — Phase 2 W1 pulled forward)
// ============================================================================

/** /pub/player/{u}/games/archives → { archives: string[] } of monthly URLs. */
export interface ArchivesList {
  archives: string[];
}

export async function fetchArchivesList(handle: string): Promise<string[]> {
  const data = await fetchJson<ArchivesList>(
    `/player/${encodeURIComponent(handle.toLowerCase())}/games/archives`,
  );
  return data?.archives ?? [];
}

/**
 * One game in a chess.com monthly archive. Field set per
 * https://www.chess.com/news/view/published-data-api#pubapi-endpoint-games-archive
 *
 * Notes:
 *  - `rules` is the variant: 'chess' is standard, others (chess960, kingofthehill,
 *    bughouse, …) we drop at filter time.
 *  - `pgn` is a full PGN string including headers.
 *  - `end_time` is unix-seconds.
 *  - White/black `result` is per-player (win/checkmated/timeout/resigned/…); the
 *    game-level outcome is reconstructed from the white side at parse time.
 */
export interface ChesscomArchiveGame {
  url: string;
  pgn?: string;
  time_control: string;
  end_time: number;
  rated: boolean;
  tcn?: string;
  uuid?: string;
  fen?: string;
  time_class: 'bullet' | 'blitz' | 'rapid' | 'daily';
  rules: string;
  white: {
    rating: number;
    result: string;
    '@id': string;
    username: string;
    uuid?: string;
  };
  black: {
    rating: number;
    result: string;
    '@id': string;
    username: string;
    uuid?: string;
  };
  eco?: string;
  accuracies?: { white: number; black: number };
}

export interface ArchiveMonth {
  games: ChesscomArchiveGame[];
}

/**
 * /pub/player/{u}/games/{YYYY}/{MM} → list of games in that month.
 * Accepts the full archive URL (as returned by fetchArchivesList) or a
 * relative path. Returns [] on 404 (chess.com returns 404 if the player
 * has no games in that month, even if the URL was listed).
 */
export async function fetchArchiveMonth(urlOrPath: string): Promise<ChesscomArchiveGame[]> {
  // The archives list returns absolute URLs; fetchJson handles both forms.
  const data = await fetchJson<ArchiveMonth>(urlOrPath);
  return data?.games ?? [];
}

/** Parse year/month out of an archives URL like '.../games/2024/01'. */
export function parseArchiveUrl(url: string): { year: number; month: number } | null {
  const m = /\/games\/(\d{4})\/(\d{2})$/.exec(url);
  if (!m) return null;
  const year = Number.parseInt(m[1]!, 10);
  const month = Number.parseInt(m[2]!, 10);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  return { year, month };
}
