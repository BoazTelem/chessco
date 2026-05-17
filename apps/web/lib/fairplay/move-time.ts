/**
 * Move-time vs. complexity analyzer. Spec §12.
 *
 * Pure function. Input: per-move records of (time_used_ms,
 * complexity_score). Output: an anomaly score and a flag verdict.
 *
 * Complexity score is 0..1 from a separate heuristic (engine eval
 * volatility + number of reasonable candidate moves). A human playing
 * naturally takes LONGER on more-complex positions; an engine-assisted
 * player either:
 *   - takes near-constant short time across complexity (paste-then-play), or
 *   - takes consistent SHORT times on high-complexity positions where a
 *     human would think.
 *
 * The Pearson correlation between time and complexity is the primary
 * signal. Clean human play is positively correlated (≥ ~0.3); engine
 * assistance flattens or inverts the correlation.
 */

export interface MoveTimeRecord {
  /** Wall-clock ms the player spent on the move. */
  timeMs: number;
  /** 0 (forced recapture) .. 1 (deeply complex middlegame). */
  complexity: number;
  /** Whether this was the player's move (skip opponent moves). */
  isPlayerMove: boolean;
}

export interface MoveTimeVerdict {
  severity: 0 | 1 | 2 | 3;
  pearson: number | null;
  signal: 'too_few_moves' | 'natural' | 'flat' | 'inverted';
  notes: string[];
}

const MIN_PLAYER_MOVES = 8;

function pearson(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const n = xs.length;
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumX2 = 0,
    sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i]!;
    sumY += ys[i]!;
    sumXY += xs[i]! * ys[i]!;
    sumX2 += xs[i]! * xs[i]!;
    sumY2 += ys[i]! * ys[i]!;
  }
  const num = n * sumXY - sumX * sumY;
  const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (den === 0) return null;
  return num / den;
}

export function analyzeMoveTime(records: MoveTimeRecord[]): MoveTimeVerdict {
  const playerMoves = records.filter((r) => r.isPlayerMove);
  if (playerMoves.length < MIN_PLAYER_MOVES) {
    return {
      severity: 0,
      pearson: null,
      signal: 'too_few_moves',
      notes: [`only ${playerMoves.length} player moves; need ${MIN_PLAYER_MOVES}+`],
    };
  }

  // Use log(timeMs) to dampen the effect of single huge thinks.
  const times = playerMoves.map((r) => Math.log(Math.max(1, r.timeMs)));
  const complexities = playerMoves.map((r) => r.complexity);
  const r = pearson(times, complexities);
  if (r === null) {
    return { severity: 0, pearson: null, signal: 'flat', notes: ['degenerate inputs'] };
  }

  if (r >= 0.3) {
    return {
      severity: 0,
      pearson: r,
      signal: 'natural',
      notes: [`r=${r.toFixed(2)} consistent with human play`],
    };
  }
  if (r >= 0.0) {
    return {
      severity: 1,
      pearson: r,
      signal: 'flat',
      notes: [`r=${r.toFixed(2)} suggests time independent of complexity`],
    };
  }
  if (r >= -0.2) {
    return {
      severity: 2,
      pearson: r,
      signal: 'inverted',
      notes: [`r=${r.toFixed(2)} weakly inverted — fast on complex positions`],
    };
  }
  return {
    severity: 3,
    pearson: r,
    signal: 'inverted',
    notes: [`r=${r.toFixed(2)} strongly inverted — fast moves where humans should think`],
  };
}
