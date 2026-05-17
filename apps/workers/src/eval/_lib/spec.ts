/**
 * Shared benchmark spec: pass/fail criteria for CQ-1, CQ-2, B11 and verdict
 * JSON shape that the /benchmarks page reads.
 *
 * Source of truth: plan file in
 *   C:\Users\boaz\.claude\plans\please-go-over-the-deep-dream.md
 *
 * Anything that publishes a benchmark must call writeVerdict() with one of
 * these IDs so the dashboard can render a uniform pass/fail strip.
 */

export type BenchmarkId =
  | 'b1' // identification top-1/top-3 (CQ-1)
  | 'b2' // identification anti-confusion (CQ-1)
  | 'b3' // repertoire matcher tree-match precision (CQ-2)
  | 'b4' // sparse-cascade recall
  | 'b5' // gelfand PGN reproduction
  | 'b6' // leak precision@5 (CQ-2)
  | 'b7' // leak recall sanity (CQ-2)
  | 'b8' // prep report end-to-end latency
  | 'b9' // identification latency
  | 'b10' // engine-correlation fairplay FP rate
  | 'b11' // AI prompt regression
  | 'b12'; // benchmark dashboard (meta — always pass if all referenced files exist)

export type VerdictStatus = 'pass' | 'fail' | 'pending' | 'error';

export interface Criterion {
  label: string;
  /** Free-text expression of the threshold, for human display */
  threshold: string;
  /** Measured value, formatted for display (e.g. "78.4%", "n/a") */
  actual: string;
  passed: boolean;
}

export interface Verdict {
  id: BenchmarkId;
  title: string;
  status: VerdictStatus;
  /**
   * One-line headline for the dashboard tile. Past-tense if the run finished
   * ("Top-1 hit 78.4%"); imperative if pending ("Awaiting prompt library").
   */
  headline: string;
  /** Per-criterion pass/fail breakdown */
  criteria: Criterion[];
  /** Source artifact this verdict was derived from, if any */
  source?: { artifact: string; runAt: string | null };
  /** When this verdict was emitted */
  generatedAt: string;
  /**
   * If status === 'error', what went wrong. Used so the dashboard can show
   * the missing-artifact case helpfully rather than just showing a red tile.
   */
  error?: string;
}

/**
 * CQ-1 identification accuracy thresholds.
 *
 * Two regimes exist: Phase 1 (federation-anchored set, ≥75% top-1) and
 * Phase 2 (mixed including anonymous-only, ≥80%). We measure both whenever
 * the underlying corpus supports it and pass when at least the Phase 1 gate
 * holds — Phase 2 is reported separately so we can see when we cross it.
 *
 * Top-3 gate applies to ≥5-game queries (high-signal regime).
 */
export const CQ1_CRITERIA = {
  top1Phase1: 0.75,
  top1Phase2: 0.8,
  top3HighSignal: 0.9,
  /** Highest sample size that still counts as a "few games" CQ-1 query. */
  fewGamesMaxSampleSize: 10,
  /** Smallest sample size that triggers the high-signal top-3 gate. */
  highSignalMinSampleSize: 5,
} as const;

/**
 * CQ-1 latency thresholds (P50 / P95) in milliseconds.
 */
export const CQ1_LATENCY_MS = {
  p50: 3000,
  p95: 8000,
} as const;

/**
 * CQ-2 leak detection thresholds. The "precision@5" gate is the canonical
 * one — at least 4 of 5 surfaced leaks must clear engine + win-rate checks.
 */
export const CQ2_CRITERIA = {
  precisionAt5: 0.8,
  recallSanity: 0.7,
  /** Generation latency P95 in milliseconds for a full prep report. */
  prepReportP95Ms: 90_000,
} as const;

/**
 * B3 repertoire matcher tree-match precision target — distinct from CQ-1
 * because B3 measures the leaf-level matcher quality, not the end-to-end
 * top-1 accuracy. Tree-match precision ≥95% on labeled positions including
 * transpositions per plan spec.
 */
export const B3_TREE_MATCH_PRECISION = 0.95;

/** Where verdict JSON files live so the web app can pick them up. */
export function verdictArtifactPath(id: BenchmarkId): string {
  return `apps/web/public/benchmarks/${id}.json`;
}
