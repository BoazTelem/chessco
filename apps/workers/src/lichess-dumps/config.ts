/**
 * Filter + ingest constants for the Lichess monthly dump worker.
 * Spec §5/PLAN.md Phase 1 W1: rated standard, last 24 months.
 *
 * Threshold set to 1400 on 2026-05-14 as the broad floor — anything below
 * is too casual for our v1 tournament-prep audience. Top-down crawl order
 * is enforced by the lichess_crawl_queue priority column (T1=1900+ first,
 * then T2/T3) rather than by raising the floor itself.
 */

export const FILTER = {
  /** Minimum of (WhiteElo, BlackElo). Both players must clear it. */
  minElo: 1400,
  /** Lichess Variant tag must equal this. */
  variant: 'Standard',
  /** PGN Event tag must include one of these (rated games only). */
  ratedEventMarkers: ['Rated'] as const,
} as const;

export const BATCH = {
  /** Games buffered before a write flush. */
  gamesPerBatch: 100,
  /** Max rows in a single INSERT — Postgres caps at 65k params per query.
   *  positions has 6 cols → 10000 safe, moves has 10 cols → 6000 safe.
   *  We round both down to 4000 for headroom. */
  maxRowsPerInsert: 4000,
  /** Bytes processed before a counter update to lichess_dump_runs. */
  progressByteInterval: 50 * 1024 * 1024, // 50 MB
} as const;

/**
 * The Lichess dump catalog page is https://database.lichess.org/.
 * Filenames follow lichess_db_standard_rated_YYYY-MM.pgn.zst.
 */
export function dumpUrl(dumpId: string): string {
  return `https://database.lichess.org/standard/lichess_db_standard_rated_${dumpId}.pgn.zst`;
}
