import type { RealTimeClass, TimeClass } from './types';

const LICHESS_API = 'https://lichess.org';

export interface LichessFetchOptions {
  handle: string;
  /** Inclusive lower bound on game timestamp. */
  since: Date;
  /** Inclusive upper bound on game timestamp. */
  until: Date;
  signal?: AbortSignal;
}

export interface RawLichessGame {
  id: string;
  pgn: string;
  playedAt: Date;
  timeClass: TimeClass;
}

const PERF_TO_TIME_CLASS: Record<string, TimeClass> = {
  bullet: 'bullet',
  blitz: 'blitz',
  rapid: 'rapid',
  classical: 'classical',
};

export async function* fetchLichessGames(
  opts: LichessFetchOptions,
): AsyncGenerator<RawLichessGame, void, void> {
  const params = new URLSearchParams({
    since: String(opts.since.getTime()),
    until: String(opts.until.getTime()),
    pgnInJson: 'true',
    clocks: 'false',
    evals: 'false',
    opening: 'false',
    literate: 'false',
    rated: 'true',
  });

  const url = `${LICHESS_API}/api/games/user/${encodeURIComponent(opts.handle)}?${params}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/x-ndjson' },
    signal: opts.signal,
    cache: 'no-store',
  });
  if (!res.ok || !res.body) {
    throw new Error(`Lichess returned ${res.status} for ${opts.handle}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const parsed = tryParseLine(line);
        if (parsed) yield parsed;
      }
    }
    if (done) break;
  }
  if (buffer.trim()) {
    const parsed = tryParseLine(buffer.trim());
    if (parsed) yield parsed;
  }
}

interface LichessNdjsonGame {
  id: string;
  pgn?: string;
  perf?: string;
  createdAt?: number;
  lastMoveAt?: number;
}

function tryParseLine(line: string): RawLichessGame | null {
  try {
    const obj = JSON.parse(line) as LichessNdjsonGame;
    if (!obj.pgn || !obj.id) return null;
    const millis = obj.createdAt ?? obj.lastMoveAt;
    if (!millis) return null;
    const tc: TimeClass = (obj.perf && PERF_TO_TIME_CLASS[obj.perf]) || 'unknown';
    return { id: obj.id, pgn: obj.pgn, playedAt: new Date(millis), timeClass: tc };
  } catch {
    return null;
  }
}

/**
 * Pull the profile's total game count across the user's selected time classes.
 * Empty set = all real classes summed. Used for the progress-bar estimate.
 */
export async function lichessProfileGameCount(
  handle: string,
  timeClasses: ReadonlySet<RealTimeClass>,
  signal?: AbortSignal,
): Promise<number | null> {
  try {
    const res = await fetch(`${LICHESS_API}/api/user/${encodeURIComponent(handle)}`, {
      headers: { Accept: 'application/json' },
      signal,
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { perfs?: Record<string, { games?: number }> };
    if (!data.perfs) return null;
    const classes: readonly RealTimeClass[] =
      timeClasses.size > 0
        ? [...timeClasses]
        : (['bullet', 'blitz', 'rapid', 'classical'] as const);
    return classes.reduce((sum, p) => sum + (data.perfs?.[p]?.games ?? 0), 0);
  } catch {
    return null;
  }
}
