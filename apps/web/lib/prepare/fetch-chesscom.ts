import type { RealTimeClass, TimeClass } from './types';

const CHESSCOM_API = 'https://api.chess.com';

export interface ChesscomFetchOptions {
  handle: string;
  since: Date;
  until: Date;
  timeClasses: ReadonlySet<RealTimeClass>;
  signal?: AbortSignal;
  onArchiveStart?: (info: { index: number; total: number; label: string }) => void;
}

export interface RawChesscomGame {
  id: string;
  pgn: string;
  playedAt: Date;
  timeClass: TimeClass;
}

interface ChesscomArchivesResponse {
  archives: string[];
}

interface ChesscomGame {
  url: string;
  uuid?: string;
  pgn?: string;
  time_class?: string;
  end_time?: number;
  rules?: string;
  rated?: boolean;
}

interface ChesscomMonthlyResponse {
  games: ChesscomGame[];
}

function archiveKeyToDate(url: string): { year: number; month: number } | null {
  const m = /\/games\/(\d{4})\/(\d{2})$/.exec(url);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]) };
}

function monthInWindow(year: number, month: number, since: Date, until: Date): boolean {
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1));
  return monthEnd > since && monthStart < until;
}

function matchesTimeClass(game: ChesscomGame, set: ReadonlySet<RealTimeClass>): boolean {
  if (set.size === 0) return true;
  const tc = game.time_class;
  if (tc === 'bullet' || tc === 'blitz' || tc === 'rapid' || tc === 'classical') {
    return set.has(tc);
  }
  return false;
}

export async function* fetchChesscomGames(
  opts: ChesscomFetchOptions,
): AsyncGenerator<RawChesscomGame, void, void> {
  const archivesRes = await fetch(
    `${CHESSCOM_API}/pub/player/${encodeURIComponent(opts.handle.toLowerCase())}/games/archives`,
    { headers: { Accept: 'application/json' }, signal: opts.signal, cache: 'no-store' },
  );
  if (!archivesRes.ok) {
    throw new Error(`chess.com returned ${archivesRes.status} for ${opts.handle} (archives)`);
  }
  const archivesJson = (await archivesRes.json()) as ChesscomArchivesResponse;
  const filtered = archivesJson.archives
    .map((url) => ({ url, key: archiveKeyToDate(url) }))
    .filter((a) => a.key && monthInWindow(a.key.year, a.key.month, opts.since, opts.until))
    .sort((a, b) => b.url.localeCompare(a.url));

  let i = 0;
  for (const { url, key } of filtered) {
    if (opts.signal?.aborted) return;
    if (!key) continue;
    opts.onArchiveStart?.({
      index: i,
      total: filtered.length,
      label: `${key.year}-${String(key.month).padStart(2, '0')}`,
    });
    i += 1;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: opts.signal,
      cache: 'no-store',
    });
    if (!res.ok) continue;
    const data = (await res.json()) as ChesscomMonthlyResponse;
    // chess.com returns a month chronologically; iterate reversed so the
    // overall stream is most-recent-first (matching Lichess) and per-move
    // sample IDs naturally capture the latest games.
    for (let gi = data.games.length - 1; gi >= 0; gi -= 1) {
      const g = data.games[gi];
      if (!g) continue;
      if (!g.pgn) continue;
      if (g.rules && g.rules !== 'chess') continue;
      if (!matchesTimeClass(g, opts.timeClasses)) continue;
      const endTime = g.end_time ? new Date(g.end_time * 1000) : null;
      if (!endTime) continue;
      if (endTime < opts.since || endTime > opts.until) continue;
      const tc: TimeClass =
        g.time_class === 'bullet' ||
        g.time_class === 'blitz' ||
        g.time_class === 'rapid' ||
        g.time_class === 'classical'
          ? g.time_class
          : 'unknown';
      yield { id: g.uuid ?? g.url, pgn: g.pgn, playedAt: endTime, timeClass: tc };
    }
  }
}
