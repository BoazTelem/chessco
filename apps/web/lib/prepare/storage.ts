import {
  clearCachedPlayer,
  flushPersistQueue,
  loadCachedGames,
  loadCachedMeta,
  persistGame,
  type CachedMeta,
} from './persist';
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

export function getStore(platform: Platform, handle: string): StoredFetch {
  const key = keyFor(platform, handle);
  let entry = store.get(key);
  if (!entry) {
    entry = { games: new Map(), earliest: null, latest: null };
    store.set(key, entry);
  }
  return entry;
}

function ingestInMemory(entry: StoredFetch, game: GameRecord): boolean {
  if (entry.games.has(game.id)) return false;
  entry.games.set(game.id, game);
  if (!entry.earliest || game.playedAt < entry.earliest) entry.earliest = game.playedAt;
  if (!entry.latest || game.playedAt > entry.latest) entry.latest = game.playedAt;
  return true;
}

export function ingestGame(platform: Platform, handle: string, game: GameRecord): boolean {
  const entry = getStore(platform, handle);
  if (!ingestInMemory(entry, game)) return false;
  persistGame(platform, handle, game);
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
      if (ingestInMemory(entry, g)) loaded += 1;
    }
    return { loaded, earliest: entry.earliest, latest: entry.latest, meta };
  })();
  hydrated.set(key, promise);
  return promise;
}

export function isHydrated(platform: Platform, handle: string): boolean {
  return hydrated.has(keyFor(platform, handle));
}

/**
 * Ensure all queued IDB writes for (platform, handle) have flushed. Call when
 * a fetch run completes so the meta row reflects the latest cached game.
 */
export function flushStore(platform: Platform, handle: string): Promise<void> {
  return flushPersistQueue(platform, handle);
}
