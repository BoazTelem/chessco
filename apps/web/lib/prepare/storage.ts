import type { GameRecord, Platform } from './types';

interface StoredFetch {
  games: Map<string, GameRecord>;
  earliest: Date | null;
  latest: Date | null;
}

const store = new Map<string, StoredFetch>();

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

export function ingestGame(platform: Platform, handle: string, game: GameRecord): boolean {
  const entry = getStore(platform, handle);
  if (entry.games.has(game.id)) return false;
  entry.games.set(game.id, game);
  if (!entry.earliest || game.playedAt < entry.earliest) entry.earliest = game.playedAt;
  if (!entry.latest || game.playedAt > entry.latest) entry.latest = game.playedAt;
  return true;
}

export function listGames(platform: Platform, handle: string): GameRecord[] {
  return [...getStore(platform, handle).games.values()];
}

export function clearStore(platform: Platform, handle: string): void {
  store.delete(keyFor(platform, handle));
}
