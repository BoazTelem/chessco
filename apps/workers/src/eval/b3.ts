/**
 * B3 — Repertoire matcher tree-match precision verdict (CQ-2).
 *
 * Reads the legacy repertoire-vector benchmark artifact and treats the
 * top-1 accuracy on the largest sample-size cohort as a proxy for
 * tree-match precision. Once a dedicated labeled-positions harness exists
 * (planned line item in WS-1 follow-up), this script switches to reading
 * that artifact instead.
 *
 *   pnpm --filter @chessco/workers bench:b3:verdict
 *   pnpm --filter @chessco/workers bench:b3
 */
import { B3_TREE_MATCH_PRECISION, type Verdict } from './_lib/spec';
import {
  errorVerdict,
  fmtPct,
  logVerdict,
  pendingVerdict,
  readArtifact,
  rollup,
  writeVerdict,
} from './_lib/verdict';

interface LegacyMetrics {
  n: number;
  top1: number;
  top3: number;
  top5: number;
  top10: number;
  median_rank: number | null;
}

interface LegacyArtifact {
  run_at: string;
  config: { depth: number; sample_sizes: number[] };
  corpus: { eligible_accounts: number; raw_game_rows_loaded: number };
  metrics_by_sample_size: Array<{ sample_size: number; metrics: LegacyMetrics }>;
}

function main(): void {
  let verdict: Verdict;
  try {
    const loaded = readArtifact<LegacyArtifact>('apps/web/public/repertoire-benchmark.json');
    if (!loaded) {
      verdict = pendingVerdict(
        'b3',
        'Repertoire matcher tree-match precision (CQ-2)',
        'No repertoire-vector artifact published yet. Run `pnpm --filter @chessco/workers eval:repertoire` first.',
      );
    } else {
      const { data, runAt } = loaded;
      const cohorts = data.metrics_by_sample_size;

      // Largest sample-size cohort approximates the "lots of evidence,
      // does the matcher get it exactly right" question that B3 asks.
      const largest =
        cohorts.length > 0
          ? cohorts.reduce((acc, c) => (c.sample_size > acc.sample_size ? c : acc))
          : null;

      const top1Ok = largest !== null && largest.metrics.top1 >= B3_TREE_MATCH_PRECISION;
      const haveCorpus = data.corpus.eligible_accounts > 0;

      const criteria = [
        {
          label: 'Tree-match precision (largest cohort top-1 proxy)',
          threshold: `≥ ${fmtPct(B3_TREE_MATCH_PRECISION)}`,
          actual: largest
            ? `${fmtPct(largest.metrics.top1)} at ${largest.sample_size} games`
            : 'no data',
          passed: top1Ok,
        },
        {
          label: 'Eligible accounts',
          threshold: '> 0',
          actual: data.corpus.eligible_accounts.toLocaleString(),
          passed: haveCorpus,
        },
      ];

      const headline = largest
        ? `Top-1 @ ${largest.sample_size} games: ${fmtPct(largest.metrics.top1)} (${data.corpus.eligible_accounts.toLocaleString()} accounts)`
        : 'No cohorts in artifact';

      verdict = {
        id: 'b3',
        title: 'Repertoire matcher tree-match precision (CQ-2)',
        status: rollup([top1Ok, haveCorpus]),
        headline,
        criteria,
        source: { artifact: 'apps/web/public/repertoire-benchmark.json', runAt },
        generatedAt: new Date().toISOString(),
      };
    }
  } catch (err) {
    verdict = errorVerdict('b3', 'Repertoire matcher tree-match precision (CQ-2)', err);
  }

  const written = writeVerdict(verdict);
  logVerdict(verdict);
  console.log(`[b3] verdict written to ${written}`);
  if (verdict.status === 'fail') process.exit(1);
}

main();
