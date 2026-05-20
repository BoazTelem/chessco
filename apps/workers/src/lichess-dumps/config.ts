/**
 * Filter + ingest constants for the Lichess monthly dump worker.
 *
 * Threshold raised to 1800 on 2026-05-20: Lichess ELO inflates ~400 points
 * above FIDE, so the prep audience floor on Lichess is 1800+ (per the
 * [Prep audience naming] memory). The previous 1400 floor was an
 * over-ingest; smoke-test against 2026-04 showed it putting hundreds of
 * thousands of sub-prep games through the positions UPSERT bottleneck.
 *
 * Semantics also changed: previously BOTH players had to clear minElo
 * (justified as "noise reduction" against mismatched games). Replaced
 * with EITHER ≥ minElo — a game between a 2400 GM and a 1500 opponent is
 * still real repertoire data for the GM, who IS our prep target. We only
 * drop games where both players are sub-prep. Combined with the floor
 * raise, this is roughly a 5-8x reduction in accepted games, which moves
 * the dump pipeline from non-viable (10 games/sec) into the steady-state
 * monthly range.
 */

export const FILTER = {
  /** EITHER player must clear this. (Lichess prep audience floor.) */
  minElo: 1800,
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
