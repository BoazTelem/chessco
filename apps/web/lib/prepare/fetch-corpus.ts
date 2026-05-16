/**
 * Pull whatever games we already have for (platform, handle) from our own
 * games corpus via GET /api/prepare/games. Phase 3 of the player-id
 * pipeline — DB-first hydration so the OpeningTreeSection renders
 * immediately instead of waiting on the platform's API (which can take
 * 30s-5min for prolific accounts).
 *
 * The endpoint returns games shaped exactly like GameRecord, with
 * playedAt as an ISO string (parsed back to Date here). The live-fetch
 * loop then handles the forward-gap delta from latest cached game.
 */
import type { GameRecord, Platform } from './types';

interface CorpusGameWire {
  id: string;
  playedAt: string;
  playerColor: 'white' | 'black';
  result: GameRecord['result'];
  resultText: GameRecord['resultText'];
  timeClass: GameRecord['timeClass'];
  whiteHandle: string;
  blackHandle: string;
  whiteElo: number | null;
  blackElo: number | null;
  movesSan: string[];
  movesUci: string[];
  fensBefore: string[];
}

interface CorpusGamesResponse {
  games: CorpusGameWire[];
  earliest: string | null;
  latest: string | null;
  hadMore: boolean;
}

export interface CorpusFetchResult {
  games: GameRecord[];
  earliest: Date | null;
  latest: Date | null;
  hadMore: boolean;
}

export async function fetchCorpusGames(
  platform: Platform,
  handle: string,
  signal?: AbortSignal,
): Promise<CorpusFetchResult> {
  const url = new URL('/api/prepare/games', window.location.origin);
  url.searchParams.set('platform', platform);
  url.searchParams.set('handle', handle);
  const res = await fetch(url.toString(), { signal });
  if (!res.ok) {
    throw new Error(`corpus fetch failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as CorpusGamesResponse;
  const games: GameRecord[] = body.games.map((g) => ({
    id: g.id,
    playedAt: new Date(g.playedAt),
    playerColor: g.playerColor,
    result: g.result,
    resultText: g.resultText,
    timeClass: g.timeClass,
    whiteHandle: g.whiteHandle,
    blackHandle: g.blackHandle,
    whiteElo: g.whiteElo,
    blackElo: g.blackElo,
    movesSan: g.movesSan,
    movesUci: g.movesUci,
    fensBefore: g.fensBefore,
  }));
  return {
    games,
    earliest: body.earliest ? new Date(body.earliest) : null,
    latest: body.latest ? new Date(body.latest) : null,
    hadMore: body.hadMore,
  };
}

/**
 * Fire-and-forget priority bump on the crawl queue. Errors are swallowed —
 * if the worker pipeline isn't reachable, the live-fetch path still
 * works for the immediate user experience.
 */
export async function bumpCorpusPriority(
  platform: Platform,
  handle: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await fetch('/api/prepare/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, handle }),
      signal,
    });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') return;
    console.warn('[prepare/enqueue] bump failed', err);
  }
}
