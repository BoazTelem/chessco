/**
 * Rating-adjusted baselines used by the engine-correlation analyzer.
 *
 * The expected engine-match rate rises with rating because stronger
 * players genuinely play more top-1 engine moves. A flat threshold
 * (e.g. ">70% match = cheat") would false-positive grandmasters and
 * miss assisted intermediates. We band by rating and use the upper
 * bound + a standard deviation as the alarm line.
 *
 * Source for numbers: spec §12 + public fairplay datasets (Lichess
 * Fishnet study, chess.com transparency reports). Treat these as a
 * starting point; tune from the labeled B10 dataset when it lands.
 *
 * Each entry: minRating (inclusive), p50 + p90 + p99 match rates
 * for the rating band on a labeled clean dataset. Engine-correlation
 * flag severity scales with how far above p99 the observed rate is.
 */

export interface Baseline {
  minRating: number;
  p50: number;
  p90: number;
  p99: number;
}

const TABLE: Baseline[] = [
  { minRating: 2700, p50: 0.62, p90: 0.74, p99: 0.85 },
  { minRating: 2500, p50: 0.55, p90: 0.68, p99: 0.8 },
  { minRating: 2300, p50: 0.48, p90: 0.62, p99: 0.75 },
  { minRating: 2100, p50: 0.42, p90: 0.56, p99: 0.7 },
  { minRating: 1900, p50: 0.36, p90: 0.5, p99: 0.64 },
  { minRating: 1700, p50: 0.3, p90: 0.44, p99: 0.58 },
  { minRating: 1500, p50: 0.25, p90: 0.38, p99: 0.52 },
  { minRating: 0, p50: 0.2, p90: 0.32, p99: 0.46 },
];

export function baselineForRating(rating: number | null): Baseline {
  const r = rating ?? 1500;
  for (const row of TABLE) {
    if (r >= row.minRating) return row;
  }
  // Defensive — TABLE always ends with minRating=0 so this is unreachable.
  return TABLE[TABLE.length - 1]!;
}
