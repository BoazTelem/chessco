import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Color, GameRecord, GameResult, Platform, TimeClass } from './types';

const DB_NAME = 'chessco-prepare';
const DB_VERSION = 1;
const GAMES_STORE = 'games';
const META_STORE = 'meta';
const BY_HANDLE_INDEX = 'byHandle';

interface PersistedGameRow {
  platform: Platform;
  handle: string;
  id: string;
  playedAtMs: number;
  playerColor: Color;
  result: GameResult;
  resultText: '1-0' | '0-1' | '1/2-1/2';
  timeClass: TimeClass;
  whiteHandle: string;
  blackHandle: string;
  whiteElo: number | null;
  blackElo: number | null;
  movesSan: string[];
  movesUci: string[];
  fensBefore: string[];
}

interface PersistedMetaRow {
  platform: Platform;
  handle: string;
  earliestMs: number;
  latestMs: number;
  updatedAtMs: number;
}

interface PrepareSchema extends DBSchema {
  [GAMES_STORE]: {
    key: [Platform, string, string];
    value: PersistedGameRow;
    indexes: { [BY_HANDLE_INDEX]: [Platform, string] };
  };
  [META_STORE]: {
    key: [Platform, string];
    value: PersistedMetaRow;
  };
}

let dbPromise: Promise<IDBPDatabase<PrepareSchema>> | null = null;

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
}

function getDB(): Promise<IDBPDatabase<PrepareSchema>> | null {
  if (!isBrowser()) return null;
  if (!dbPromise) {
    dbPromise = openDB<PrepareSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(GAMES_STORE)) {
          const games = db.createObjectStore(GAMES_STORE, {
            keyPath: ['platform', 'handle', 'id'],
          });
          games.createIndex(BY_HANDLE_INDEX, ['platform', 'handle']);
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: ['platform', 'handle'] });
        }
      },
    }).catch((err) => {
      // Reset so a later call can retry once the failure cause clears
      // (e.g. private-browsing IDB quirks). Persistence is best-effort.
      dbPromise = null;
      console.warn('[prepare/persist] openDB failed', err);
      throw err;
    });
  }
  return dbPromise;
}

function toRow(platform: Platform, handle: string, game: GameRecord): PersistedGameRow {
  return {
    platform,
    handle,
    id: game.id,
    playedAtMs: game.playedAt.getTime(),
    playerColor: game.playerColor,
    result: game.result,
    resultText: game.resultText,
    timeClass: game.timeClass,
    whiteHandle: game.whiteHandle,
    blackHandle: game.blackHandle,
    whiteElo: game.whiteElo,
    blackElo: game.blackElo,
    movesSan: game.movesSan,
    movesUci: game.movesUci,
    fensBefore: game.fensBefore,
  };
}

function fromRow(row: PersistedGameRow): GameRecord {
  return {
    id: row.id,
    playedAt: new Date(row.playedAtMs),
    playerColor: row.playerColor,
    result: row.result,
    resultText: row.resultText,
    timeClass: row.timeClass,
    whiteHandle: row.whiteHandle,
    blackHandle: row.blackHandle,
    whiteElo: row.whiteElo,
    blackElo: row.blackElo,
    movesSan: row.movesSan,
    movesUci: row.movesUci,
    fensBefore: row.fensBefore,
  };
}

export interface CachedMeta {
  earliest: Date;
  latest: Date;
  updatedAt: Date;
}

export async function loadCachedMeta(
  platform: Platform,
  handle: string,
): Promise<CachedMeta | null> {
  const dbp = getDB();
  if (!dbp) return null;
  try {
    const db = await dbp;
    const row = await db.get(META_STORE, [platform, handle.toLowerCase()]);
    if (!row) return null;
    return {
      earliest: new Date(row.earliestMs),
      latest: new Date(row.latestMs),
      updatedAt: new Date(row.updatedAtMs),
    };
  } catch (err) {
    console.warn('[prepare/persist] loadCachedMeta failed', err);
    return null;
  }
}

export async function loadCachedGames(platform: Platform, handle: string): Promise<GameRecord[]> {
  const dbp = getDB();
  if (!dbp) return [];
  try {
    const db = await dbp;
    const rows = await db.getAllFromIndex(GAMES_STORE, BY_HANDLE_INDEX, [
      platform,
      handle.toLowerCase(),
    ]);
    return rows.map(fromRow);
  } catch (err) {
    console.warn('[prepare/persist] loadCachedGames failed', err);
    return [];
  }
}

export async function clearCachedPlayer(platform: Platform, handle: string): Promise<void> {
  const dbp = getDB();
  if (!dbp) return;
  try {
    const db = await dbp;
    const key = handle.toLowerCase();
    const tx = db.transaction([GAMES_STORE, META_STORE], 'readwrite');
    const games = tx.objectStore(GAMES_STORE);
    const idx = games.index(BY_HANDLE_INDEX);
    let cursor = await idx.openCursor([platform, key]);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.objectStore(META_STORE).delete([platform, key]);
    await tx.done;
  } catch (err) {
    console.warn('[prepare/persist] clearCachedPlayer failed', err);
  }
}

// ---- Write queue --------------------------------------------------------
// Persistence is fire-and-forget so the fetch loop in OpeningTreeSection
// stays synchronous. Buffer per-game writes and flush in one transaction
// every BATCH_SIZE games or FLUSH_MS milliseconds, whichever comes first.

const BATCH_SIZE = 50;
const FLUSH_MS = 250;

interface QueuedWrite {
  row: PersistedGameRow;
  playedAtMs: number;
}

interface HandleQueue {
  platform: Platform;
  handle: string;
  writes: QueuedWrite[];
  earliestMs: number | null;
  latestMs: number | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  pending: Promise<void>;
}

const queues = new Map<string, HandleQueue>();

function queueKey(platform: Platform, handle: string): string {
  return `${platform}:${handle.toLowerCase()}`;
}

function getQueue(platform: Platform, handle: string): HandleQueue {
  const key = queueKey(platform, handle);
  let q = queues.get(key);
  if (!q) {
    q = {
      platform,
      handle: handle.toLowerCase(),
      writes: [],
      earliestMs: null,
      latestMs: null,
      flushTimer: null,
      pending: Promise.resolve(),
    };
    queues.set(key, q);
  }
  return q;
}

async function flushQueue(q: HandleQueue): Promise<void> {
  if (q.flushTimer) {
    clearTimeout(q.flushTimer);
    q.flushTimer = null;
  }
  if (q.writes.length === 0) return;
  const dbp = getDB();
  if (!dbp) {
    q.writes = [];
    return;
  }
  const batch = q.writes.splice(0);
  const earliestMs = q.earliestMs;
  const latestMs = q.latestMs;
  try {
    const db = await dbp;
    const tx = db.transaction([GAMES_STORE, META_STORE], 'readwrite');
    const gamesStore = tx.objectStore(GAMES_STORE);
    for (const w of batch) {
      gamesStore.put(w.row);
    }
    if (earliestMs !== null && latestMs !== null) {
      const metaStore = tx.objectStore(META_STORE);
      const existing = await metaStore.get([q.platform, q.handle]);
      const mergedEarliest =
        existing && existing.earliestMs < earliestMs ? existing.earliestMs : earliestMs;
      const mergedLatest = existing && existing.latestMs > latestMs ? existing.latestMs : latestMs;
      metaStore.put({
        platform: q.platform,
        handle: q.handle,
        earliestMs: mergedEarliest,
        latestMs: mergedLatest,
        updatedAtMs: Date.now(),
      });
    }
    await tx.done;
  } catch (err) {
    console.warn('[prepare/persist] flushQueue failed', err);
  }
}

export function persistGame(platform: Platform, handle: string, game: GameRecord): void {
  if (!isBrowser()) return;
  const q = getQueue(platform, handle);
  const row = toRow(platform, handle.toLowerCase(), game);
  q.writes.push({ row, playedAtMs: row.playedAtMs });
  q.earliestMs =
    q.earliestMs === null || row.playedAtMs < q.earliestMs ? row.playedAtMs : q.earliestMs;
  q.latestMs = q.latestMs === null || row.playedAtMs > q.latestMs ? row.playedAtMs : q.latestMs;
  if (q.writes.length >= BATCH_SIZE) {
    q.pending = q.pending.then(() => flushQueue(q));
    return;
  }
  if (!q.flushTimer) {
    q.flushTimer = setTimeout(() => {
      q.pending = q.pending.then(() => flushQueue(q));
    }, FLUSH_MS);
  }
}

export async function flushPersistQueue(platform: Platform, handle: string): Promise<void> {
  if (!isBrowser()) return;
  const q = getQueue(platform, handle);
  q.pending = q.pending.then(() => flushQueue(q));
  await q.pending;
}
