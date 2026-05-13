/**
 * Filter + ingest constants for the Lichess monthly dump worker.
 * Spec §5/PLAN.md Phase 1 W1: rated standard, Elo >= 1200, last 24 months.
 *
 * Threshold lowered from 1500 → 1200 on 2026-05-13 as part of the
 * comprehensive seed expansion plan: capture tournament-active players
 * beyond the top tier.
 */

export const FILTER = {
  /** Minimum of (WhiteElo, BlackElo). Both players must clear it. */
  minElo: 1200,
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
