import type { RealTimeClass, TimeClass } from './types';

const LICHESS_API = 'https://lichess.org';

// Resume policy: Lichess streams a single long ndjson connection that
// frequently drops on large profiles. When the stream errors we restart
// from the oldest game already seen — ingestGame() dedups by game id, so
// the boundary game getting re-yielded is harmless.
const MAX_RETRIES_WITHOUT_PROGRESS = 3;
const RETRY_BASE_DELAY_MS = 1500;

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
  const sinceMs = opts.since.getTime();
  let until = opts.until.getTime();
  let attemptsWithoutProgress = 0;
  let lastSeenMs: number | null = null;

  while (true) {
    if (until < sinceMs) return;

    const params = new URLSearchParams({
      since: String(sinceMs),
      until: String(until),
      pgnInJson: 'true',
      clocks: 'false',
      evals: 'false',
      opening: 'false',
      literate: 'false',
      rated: 'true',
    });

    const url = `${LICHESS_API}/api/games/user/${encodeURIComponent(opts.handle)}?${params}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Accept: 'application/x-ndjson' },
        signal: opts.signal,
        cache: 'no-store',
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      if (attemptsWithoutProgress >= MAX_RETRIES_WITHOUT_PROGRESS) throw err;
      attemptsWithoutProgress += 1;
      await sleep(RETRY_BASE_DELAY_MS * attemptsWithoutProgress, opts.signal);
      continue;
    }

    if (!res.ok || !res.body) {
      const retriable = res.status === 429 || res.status >= 500;
      if (retriable && attemptsWithoutProgress < MAX_RETRIES_WITHOUT_PROGRESS) {
        attemptsWithoutProgress += 1;
        const factor = res.status === 429 ? 4 : 1;
        await sleep(RETRY_BASE_DELAY_MS * attemptsWithoutProgress * factor, opts.signal);
        continue;
      }
      throw new Error(`Lichess returned ${res.status} for ${opts.handle}`);
    }

    const progressBefore = lastSeenMs;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamErr: unknown = null;
    try {
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
            if (parsed) {
              lastSeenMs = parsed.playedAt.getTime();
              yield parsed;
            }
          }
        }
        if (done) break;
      }
      if (buffer.trim()) {
        const parsed = tryParseLine(buffer.trim());
        if (parsed) {
          lastSeenMs = parsed.playedAt.getTime();
          yield parsed;
        }
      }
      return;
    } catch (err) {
      streamErr = err;
    }

    if (opts.signal?.aborted) throw streamErr;

    const madeProgress = lastSeenMs !== null && lastSeenMs !== progressBefore;
    if (madeProgress && lastSeenMs !== null) {
      // Lichess sorts dateDesc by default, so the last game we yielded has
      // the smallest timestamp seen. Resume inclusive on that boundary;
      // ingestGame() will drop the duplicate.
      const newUntil = lastSeenMs;
      if (newUntil >= until) throw streamErr;
      until = newUntil;
      attemptsWithoutProgress = 0;
      await sleep(RETRY_BASE_DELAY_MS, opts.signal);
      continue;
    }

    if (attemptsWithoutProgress >= MAX_RETRIES_WITHOUT_PROGRESS) throw streamErr;
    attemptsWithoutProgress += 1;
    await sleep(RETRY_BASE_DELAY_MS * attemptsWithoutProgress, opts.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort);
  });
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
