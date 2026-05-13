/**
 * Header-only Lichess dump scan.
 *
 * Streams a .pgn.zst dump exactly the same way the full-ingest path
 * does, but skips processGame() / ingestBatch() entirely. Instead we
 * parse [White], [Black], [WhiteElo], [BlackElo], [UTCDate] from each
 * accepted game's headers, aggregate per-handle in memory, and bulk-
 * upsert into lichess_crawl_queue at the end.
 *
 * Purpose: discover hundreds of thousands of Lichess handles to seed
 * the crawler with, without paying the full ingest cost. The per-
 * handle crawler then fetches each handle's last 12 months via the
 * games-user API.
 *
 * Memory profile: ~50 bytes/handle × ~1M handles = ~50 MB peak. Fine.
 */
import type postgres from 'postgres';
import type { DumpStream } from './download';
import { shouldIngest, emptyFilterStats, type FilterStats } from './filter';
import { streamGames } from './pgn-stream';

/** Per-handle aggregation. last_seen is a Unix-ms timestamp. */
export interface HandleAggRow {
  handle: string;
  maxElo: number;
  lastSeenMs: number;
  gamesSeen: number;
}

export interface ScanResult {
  filter: FilterStats;
  handles: Map<string, HandleAggRow>;
  bytesRead: number;
  elapsedSec: number;
}

interface ScanArgs {
  maxGames: number | null;
  progressByteInterval: number;
}

/**
 * Stream the dump, filter, aggregate handles+ratings.
 *
 * Pure function — does NOT touch the DB. Caller is responsible for
 * flushing the returned Map via flushHandlesToQueue.
 */
export async function scanHandlesFromDump(
  dump: DumpStream,
  args: ScanArgs,
  onProgress?: (s: {
    bytesRead: number;
    gamesSeen: number;
    gamesAccepted: number;
    handles: number;
  }) => void,
): Promise<ScanResult> {
  const filter = emptyFilterStats();
  const handles = new Map<string, HandleAggRow>();
  let lastTickBytes = 0;
  const startedAt = Date.now();

  for await (const game of streamGames(dump.text)) {
    if (!shouldIngest(game.headers, filter)) continue;

    const we = parseEloOrNull(game.headers.WhiteElo);
    const be = parseEloOrNull(game.headers.BlackElo);
    const playedMs = parsePlayedMs(game.headers.UTCDate, game.headers.UTCTime);
    const w = game.headers.White?.trim().toLowerCase();
    const b = game.headers.Black?.trim().toLowerCase();

    if (w && we !== null) bump(handles, w, we, playedMs);
    if (b && be !== null) bump(handles, b, be, playedMs);

    const bytes = dump.getCompressedBytesRead();
    if (bytes - lastTickBytes >= args.progressByteInterval) {
      lastTickBytes = bytes;
      if (onProgress) {
        onProgress({
          bytesRead: bytes,
          gamesSeen: filter.seen,
          gamesAccepted: filter.accepted,
          handles: handles.size,
        });
      }
    }

    if (args.maxGames !== null && filter.accepted >= args.maxGames) break;
  }

  return {
    filter,
    handles,
    bytesRead: dump.getCompressedBytesRead(),
    elapsedSec: (Date.now() - startedAt) / 1000,
  };
}

function bump(
  map: Map<string, HandleAggRow>,
  handle: string,
  elo: number,
  playedMs: number | null,
): void {
  const existing = map.get(handle);
  if (!existing) {
    map.set(handle, {
      handle,
      maxElo: elo,
      lastSeenMs: playedMs ?? 0,
      gamesSeen: 1,
    });
    return;
  }
  if (elo > existing.maxElo) existing.maxElo = elo;
  if (playedMs !== null && playedMs > existing.lastSeenMs) existing.lastSeenMs = playedMs;
  existing.gamesSeen++;
}

function parseEloOrNull(s: string | undefined): number | null {
  if (!s || s === '?' || s === '-') return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function parsePlayedMs(date: string | undefined, time: string | undefined): number | null {
  if (!date || date.startsWith('?')) return null;
  const [y, m, d] = date.split('.').map((s) => Number.parseInt(s, 10));
  if (!y || !m || !d) return null;
  const t = time ?? '00:00:00';
  const [hh, mm, ss] = t.split(':').map((s) => Number.parseInt(s, 10));
  const dt = Date.UTC(y, m - 1, d, hh || 0, mm || 0, ss || 0);
  return Number.isFinite(dt) ? dt : null;
}

/**
 * Bulk-upsert the aggregated handles into lichess_crawl_queue.
 *
 * Priority = floor(maxElo / 100) so workers naturally drain higher-
 * rated players first (e.g., a 2400-rated handle gets priority=24,
 * a 1200 gets priority=12).
 *
 * Idempotent via ON CONFLICT (handle) DO UPDATE — re-running raises
 * priority if a higher rating is observed, leaves status alone.
 */
export async function flushHandlesToQueue(
  sql: postgres.Sql,
  handles: Map<string, HandleAggRow>,
): Promise<{ inserted: number; updated: number }> {
  if (handles.size === 0) return { inserted: 0, updated: 0 };
  const insert = sql as unknown as (rows: object[], ...cols: string[]) => postgres.Helper<object[]>;

  const CHUNK = 5000;
  const rows = [...handles.values()].map((h) => ({
    handle: h.handle,
    priority: Math.floor(h.maxElo / 100),
  }));

  let inserted = 0;
  let updated = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    // xmax = 0 in RETURNING means the row was inserted; non-zero means UPDATE.
    const r = await sql<{ inserted_now: boolean }[]>`
      INSERT INTO lichess_crawl_queue
        ${insert(chunk, 'handle', 'priority')}
      ON CONFLICT (handle) DO UPDATE SET
        priority = GREATEST(lichess_crawl_queue.priority, EXCLUDED.priority)
      RETURNING (xmax = 0) AS inserted_now
    `;
    for (const row of r) {
      if (row.inserted_now) inserted++;
      else updated++;
    }
  }
  return { inserted, updated };
}
