/**
 * B1 — Identification top-1/top-3 verdict (CQ-1).
 *
 * Reads the sparse-cascade benchmark artifact and applies the CQ-1
 * thresholds from _lib/spec.ts:
 *   · Top-1 ≥75% on any sample-size cohort (Phase 1 gate)
 *   · Top-3 ≥90% on the ≥5-game cohort (high-signal gate)
 *
 * If the artifact is missing or empty, emits a "pending" verdict so the
 * dashboard surfaces the missing-data case rather than a red tile.
 *
 *   pnpm --filter @chessco/workers bench:b1:verdict
 *   pnpm --filter @chessco/workers bench:b1                # runs eval:cascade then this
 */
import { Criterion, CQ1_CRITERIA, type Verdict } from './_lib/spec';
import {
  errorVerdict,
  fmtPct,
  logVerdict,
  pendingVerdict,
  readArtifact,
  rollup,
  writeVerdict,
} from './_lib/verdict';

interface SparseMetrics {
  trials: number;
  top1: number;
  top3: number;
  top10: number;
  median_rank: number | null;
  mrr: number;
}

interface SparseArtifact {
  ts: string;
  finished_at?: string;
  config: { sample_sizes: number[]; seeds: number[] };
  total_targets: number;
  total_trials: number;
  metrics_by_sample_size: Array<{ sample_size: number; metrics: SparseMetrics }>;
}

function main(): void {
  let verdict: Verdict;
  try {
    const loaded = readArtifact<SparseArtifact>('apps/web/public/sparse-cascade-benchmark.json');
    if (!loaded) {
      verdict = pendingVerdict(
        'b1',
        'Identification top-1 / top-3 (CQ-1)',
        'No sparse-cascade artifact published yet. Run `pnpm --filter @chessco/workers eval:cascade` first.',
      );
    } else {
      const { data, runAt } = loaded;
      const cohorts = data.metrics_by_sample_size;

      // Best top-1 across any cohort — that's the Phase 1 headline number.
      const best = cohorts.reduce<{ size: number; top1: number } | null>((acc, c) => {
        if (acc === null || c.metrics.top1 > acc.top1)
          return { size: c.sample_size, top1: c.metrics.top1 };
        return acc;
      }, null);

      // Top-3 on the smallest high-signal cohort (≥5 games).
      const highSignal =
        cohorts
          .filter((c) => c.sample_size >= CQ1_CRITERIA.highSignalMinSampleSize)
          .sort((a, b) => a.sample_size - b.sample_size)[0] ?? null;

      const top1Ok = best !== null && best.top1 >= CQ1_CRITERIA.top1Phase1;
      const top1Phase2Ok = best !== null && best.top1 >= CQ1_CRITERIA.top1Phase2;
      const top3Ok = highSignal !== null && highSignal.metrics.top3 >= CQ1_CRITERIA.top3HighSignal;
      const haveTrials = data.total_trials > 0;

      const criteria: Criterion[] = [
        {
          label: 'Top-1 (Phase 1 gate, best cohort)',
          threshold: `≥ ${fmtPct(CQ1_CRITERIA.top1Phase1)}`,
          actual: best ? `${fmtPct(best.top1)} at ${best.size} games` : 'no data',
          passed: top1Ok,
        },
        {
          label: 'Top-1 (Phase 2 gate)',
          threshold: `≥ ${fmtPct(CQ1_CRITERIA.top1Phase2)}`,
          actual: best ? fmtPct(best.top1) : 'no data',
          // Phase 2 is reported but not required for B1 to pass; we surface
          // it as info-only so we can see when we've crossed it.
          passed: top1Phase2Ok,
        },
        {
          label: `Top-3 (≥${CQ1_CRITERIA.highSignalMinSampleSize}-game cohort)`,
          threshold: `≥ ${fmtPct(CQ1_CRITERIA.top3HighSignal)}`,
          actual: highSignal
            ? `${fmtPct(highSignal.metrics.top3)} at ${highSignal.sample_size} games`
            : 'no high-signal cohort',
          passed: top3Ok,
        },
        {
          label: 'Trials recorded',
          threshold: '> 0',
          actual: data.total_trials.toLocaleString(),
          passed: haveTrials,
        },
      ];

      // B1 passes when the Phase 1 top-1 gate and the trials gate hold.
      // Top-3 high-signal is required when there's any ≥5-game cohort; if
      // none exists, that criterion is effectively non-applicable (we leave
      // it as failed so it's visible and addressable).
      const requiredPasses =
        highSignal !== null ? [top1Ok, top3Ok, haveTrials] : [top1Ok, haveTrials];

      const headline = best
        ? `Top-1 best cohort: ${fmtPct(best.top1)} at ${best.size} games` +
          (highSignal
            ? `, Top-3@${highSignal.sample_size}: ${fmtPct(highSignal.metrics.top3)}`
            : '')
        : 'No cohorts in artifact';

      verdict = {
        id: 'b1',
        title: 'Identification top-1 / top-3 (CQ-1)',
        status: rollup(requiredPasses),
        headline,
        criteria,
        source: { artifact: 'apps/web/public/sparse-cascade-benchmark.json', runAt },
        generatedAt: new Date().toISOString(),
      };
    }
  } catch (err) {
    verdict = errorVerdict('b1', 'Identification top-1 / top-3 (CQ-1)', err);
  }

  const written = writeVerdict(verdict);
  logVerdict(verdict);
  console.log(`[b1] verdict written to ${written}`);
  if (verdict.status === 'fail') process.exit(1);
}

main();
