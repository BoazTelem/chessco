export function simplifyCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export interface RecencyTrend {
  kind: 'trending' | 'fading' | 'neutral';
  ratio: number;
}

/**
 * Compare a move's average weight-per-game against the node's average to
 * detect whether it's being played more recently than the node baseline.
 * Returns 'trending' when the move's recency is ≥15% above the node's mean,
 * 'fading' when it's ≥15% below.
 */
export function recencyTrend(
  moveWeighted: number,
  moveGames: number,
  nodeWeighted: number,
  nodeGames: number,
): RecencyTrend {
  if (moveGames < 3 || nodeGames < 6 || nodeWeighted <= 0) {
    return { kind: 'neutral', ratio: 1 };
  }
  const moveAvg = moveWeighted / moveGames;
  const nodeAvg = nodeWeighted / nodeGames;
  if (nodeAvg <= 0) return { kind: 'neutral', ratio: 1 };
  const ratio = moveAvg / nodeAvg;
  if (ratio >= 1.15) return { kind: 'trending', ratio };
  if (ratio <= 0.85) return { kind: 'fading', ratio };
  return { kind: 'neutral', ratio };
}

/**
 * Performance color from win-rate (0..1). Red at 0% → gold at 50% → green at 100%.
 * Returns an HSL string.
 */
export function performanceColor(winRate: number, alpha = 1): string {
  const clamped = Math.max(0, Math.min(1, winRate));
  // Hue: 0 (red) at 0%, 47 (gold) at 50%, 145 (green) at 100%
  let hue: number;
  if (clamped < 0.5) {
    hue = 0 + (47 - 0) * (clamped / 0.5);
  } else {
    hue = 47 + (145 - 47) * ((clamped - 0.5) / 0.5);
  }
  // Lightness pulled to 40% (from 50%) so arrows contrast against the
  // brand-yellow dark squares of the Chessco board.
  const sat = 80;
  const light = 40;
  return `hsla(${hue.toFixed(0)}, ${sat}%, ${light}%, ${alpha.toFixed(2)})`;
}
