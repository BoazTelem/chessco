import {
  clearCachedPlayer,
  flushPersistQueue,
  loadCachedGames,
  loadCachedMeta,
  persistGame,
  type CachedMeta,
} from './persist';
import { fetchCorpusGames } from './fetch-corpus';
import type { GameRecord, Platform } from './types';

interface StoredFetch {
  games: Map<string, GameRecord>;
  earliest: Date | null;
  latest: Date | null;
}

const store = new Map<string, StoredFetch>();
const hydrated = new Map<string, Promise<HydrateResult>>();

function keyFor(platform: Platform, handle: string): string {
  return `${platform}:${handle.toLowerCase()}`;
}

function canonicalGameId(platform: Platform, id: string): string {
  if (platform !== 'chess.com') return id;
  const trimmed = id.trim();
  const urlId = /\/(\d+)(?:\?.*)?$/.exec(trimmed);
  return urlId?.[1] ?? trimmed;
}

function canonicalizeGame(platform: Platform, game: GameRecord): GameRecord {
  const id = canonicalGameId(platform, game.id);
  return id === game.id ? game : { ...game, id };
}

export function getStore(platform: Platform, handle: string): StoredFetch {
  const key = keyFor(platform, handle);
  let entry = store.get(key);
  if (!entry) {
    entry = { games: new Map(), earliest: null, latest: null };
    store.set(key, entry);
  }
  return entry;
}

function ingestInMemory(platform: Platform, entry: StoredFetch, game: GameRecord): boolean {
  const normalizedGame = canonicalizeGame(platform, game);
  if (entry.games.has(normalizedGame.id)) return false;
  entry.games.set(normalizedGame.id, normalizedGame);
  if (!entry.earliest || normalizedGame.playedAt < entry.earliest) {
    entry.earliest = normalizedGame.playedAt;
  }
  if (!entry.latest || normalizedGame.playedAt > entry.latest) {
    entry.latest = normalizedGame.playedAt;
  }
  return true;
}

export function ingestGame(platform: Platform, handle: string, game: GameRecord): boolean {
  const entry = getStore(platform, handle);
  const normalizedGame = canonicalizeGame(platform, game);
  if (!ingestInMemory(platform, entry, normalizedGame)) return false;
  persistGame(platform, handle, normalizedGame);
  return true;
}

export function listGames(platform: Platform, handle: string): GameRecord[] {
  return [...getStore(platform, handle).games.values()];
}

export async function clearStore(platform: Platform, handle: string): Promise<void> {
  store.delete(keyFor(platform, handle));
  hydrated.delete(keyFor(platform, handle));
  await clearCachedPlayer(platform, handle);
}

export interface HydrateResult {
  loaded: number;
  earliest: Date | null;
  latest: Date | null;
  meta: CachedMeta | null;
}

/**
 * Load any games already cached in IndexedDB for (platform, handle) into the
 * in-memory store. Idempotent per (platform, handle): subsequent calls return
 * the same promise so the component can await on mount without re-reading IDB.
 */
export function hydrateStore(platform: Platform, handle: string): Promise<HydrateResult> {
  const key = keyFor(platform, handle);
  const existing = hydrated.get(key);
  if (existing) return existing;
  const promise = (async (): Promise<HydrateResult> => {
    const entry = getStore(platform, handle);
    const [games, meta] = await Promise.all([
      loadCachedGames(platform, handle),
      loadCachedMeta(platform, handle),
    ]);
    let loaded = 0;
    for (const g of games) {
      if (ingestInMemory(platform, entry, g)) loaded += 1;
    }
    return { loaded, earliest: entry.earliest, latest: entry.latest, meta };
  })();
  hydrated.set(key, promise);
  return promise;
}

export function isHydrated(platform: Platform, handle: string): boolean {
  return hydrated.has(keyFor(platform, handle));
}

export interface CorpusHydrateResult {
  loaded: number;
  earliest: Date | null;
  latest: Date | null;
}

const corpusHydrated = new Map<string, Promise<CorpusHydrateResult>>();

/**
 * Pull DB-stored games via /api/prepare/games and merge them into the
 * in-memory store (also persisting to IDB via ingestGame). Idempotent
 * per (platform, handle): a second call within the same tab returns the
 * cached promise so we don't double-fetch the corpus.
 */
export function hydrateFromCorpus(
  platform: Platform,
  handle: string,
  signal?: AbortSignal,
): Promise<CorpusHydrateResult> {
  const key = keyFor(platform, handle);
  const existing = corpusHydrated.get(key);
  if (existing) return existing;
  const promise = (async (): Promise<CorpusHydrateResult> => {
    let result;
    try {
      result = await fetchCorpusGames(platform, handle, signal);
    } catch (err) {
      // Don't poison the cache on failure — let a later call retry.
      corpusHydrated.delete(key);
      if ((err as { name?: string })?.name === 'AbortError') {
        return { loaded: 0, earliest: null, latest: null };
      }
      console.warn('[prepare/storage] corpus hydrate failed', err);
      return { loaded: 0, earliest: null, latest: null };
    }
    const entry = getStore(platform, handle);
    let loaded = 0;
    for (const g of result.games) {
      if (ingestGame(platform, handle, g)) loaded += 1;
    }
    return { loaded, earliest: entry.earliest, latest: entry.latest };
  })();
  corpusHydrated.set(key, promise);
  return promise;
}

/**
 * Ensure all queued IDB writes for (platform, handle) have flushed. Call when
 * a fetch run completes so the meta row reflects the latest cached game.
 */
export function flushStore(platform: Platform, handle: string): Promise<void> {
  return flushPersistQueue(platform, handle);
}
