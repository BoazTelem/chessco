/**
 * B8 — Prep report end-to-end latency P95 verdict (CQ-2).
 *
 * Reads a measured-latency dataset at
 *   apps/workers/src/eval/fixtures/leak-eval/prep-latency.json
 *   { samples: [{ opponent_id, latency_ms }] }
 *
 * Operator collects samples in production by timing the
 * GET /api/prepare/reports/[id] full path (compute → leaks → render).
 * Plan spec: P95 < 90s on a 5-opponent sample.
 *
 *   pnpm --filter @chessco/workers bench:b8
 */
import { CQ2_CRITERIA, type Verdict } from './_lib/spec';
import {
  errorVerdict,
  fmtMs,
  logVerdict,
  pendingVerdict,
  readArtifact,
  rollup,
  writeVerdict,
} from './_lib/verdict';

interface LatencySample {
  opponent_id: string;
  latency_ms: number;
}

interface LatencyArtifact {
  generated_at: string;
  samples: LatencySample[];
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[idx] ?? null;
}

function main(): void {
  let verdict: Verdict;
  try {
    const loaded = readArtifact<LatencyArtifact>(
      'apps/workers/src/eval/fixtures/leak-eval/prep-latency.json',
    );
    if (!loaded) {
      verdict = pendingVerdict(
        'b8',
        'Prep report latency P95 (CQ-2)',
        'No prep-latency dataset published yet. Capture 5+ samples by timing GET /api/prepare/reports/[id] ' +
          'in production; drop the JSON at apps/workers/src/eval/fixtures/leak-eval/prep-latency.json.',
      );
    } else {
      const { data, runAt } = loaded;
      const sorted = data.samples.map((s) => s.latency_ms).sort((a, b) => a - b);
      const p95 = percentile(sorted, 0.95);
      const p50 = percentile(sorted, 0.5);
      const haveEnough = sorted.length >= 5;
      const p95Ok = p95 !== null && p95 < CQ2_CRITERIA.prepReportP95Ms;

      const criteria = [
        {
          label: 'P95 latency',
          threshold: `< ${fmtMs(CQ2_CRITERIA.prepReportP95Ms)}`,
          actual: fmtMs(p95),
          passed: p95Ok,
        },
        {
          label: 'Sample count',
          threshold: '≥ 5',
          actual: sorted.length.toString(),
          passed: haveEnough,
        },
      ];

      verdict = {
        id: 'b8',
        title: 'Prep report latency P95 (CQ-2)',
        status: rollup([p95Ok, haveEnough]),
        headline: `n=${sorted.length}, P50 ${fmtMs(p50)}, P95 ${fmtMs(p95)}`,
        criteria,
        source: { artifact: 'apps/workers/src/eval/fixtures/leak-eval/prep-latency.json', runAt },
        generatedAt: new Date().toISOString(),
      };
    }
  } catch (err) {
    verdict = errorVerdict('b8', 'Prep report latency P95 (CQ-2)', err);
  }

  const written = writeVerdict(verdict);
  logVerdict(verdict);
  console.log(`[b8] verdict written to ${written}`);
  if (verdict.status === 'fail') process.exit(1);
}

main();
