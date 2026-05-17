/**
 * B7 — Leak recall sanity verdict (CQ-2).
 *
 * Reads a hand-labeled recall dataset at
 *   apps/workers/src/eval/fixtures/leak-eval/recall.json
 * where each opponent has a small set of "known weak lines" curated by a
 * human reviewer. The benchmark passes when ≥70% of those known leaks
 * appear in the top-10 surfaced output (per plan §B7).
 *
 * Dataset shape:
 *   {
 *     opponents: [
 *       {
 *         opponent_id: "platform:handle",
 *         user_color: "white" | "black",
 *         known_leak_fingerprints: ["fp1", "fp2", ...],
 *         surfaced_top10_fingerprints: ["fp1", "fp3", "fp9", ...]
 *       }
 *     ]
 *   }
 *
 *   pnpm --filter @chessco/workers bench:b7
 */
import { CQ2_CRITERIA, type Verdict } from './_lib/spec';
import {
  errorVerdict,
  fmtPct,
  logVerdict,
  pendingVerdict,
  readArtifact,
  rollup,
  writeVerdict,
} from './_lib/verdict';

interface RecallOpponent {
  opponent_id: string;
  user_color: 'white' | 'black';
  known_leak_fingerprints: string[];
  surfaced_top10_fingerprints: string[];
}

interface RecallArtifact {
  generated_at: string;
  opponents: RecallOpponent[];
}

function main(): void {
  let verdict: Verdict;
  try {
    const loaded = readArtifact<RecallArtifact>(
      'apps/workers/src/eval/fixtures/leak-eval/recall.json',
    );
    if (!loaded) {
      verdict = pendingVerdict(
        'b7',
        'Leak recall sanity (CQ-2)',
        'No leak-recall dataset published yet. Curate 10 opponents with known-weak-line labels ' +
          'and drop them at apps/workers/src/eval/fixtures/leak-eval/recall.json.',
      );
    } else {
      const { data, runAt } = loaded;
      let totalKnown = 0;
      let totalRecalled = 0;
      const perOpponent: Array<{ id: string; recall: number; known: number }> = [];

      for (const opp of data.opponents) {
        const known = opp.known_leak_fingerprints.length;
        if (known === 0) continue;
        const surfaced = new Set(opp.surfaced_top10_fingerprints);
        const recalled = opp.known_leak_fingerprints.filter((fp) => surfaced.has(fp)).length;
        totalKnown += known;
        totalRecalled += recalled;
        perOpponent.push({ id: opp.opponent_id, recall: recalled / known, known });
      }

      const recall = totalKnown > 0 ? totalRecalled / totalKnown : 0;
      const recallOk = recall >= CQ2_CRITERIA.recallSanity;
      const enoughOpponents = perOpponent.length >= 10;

      const criteria = [
        {
          label: 'Aggregate recall (known leaks in top-10)',
          threshold: `≥ ${fmtPct(CQ2_CRITERIA.recallSanity)}`,
          actual: `${fmtPct(recall)} (${totalRecalled}/${totalKnown})`,
          passed: recallOk,
        },
        {
          label: 'Hand-labeled opponents',
          threshold: '≥ 10',
          actual: perOpponent.length.toString(),
          passed: enoughOpponents,
        },
      ];

      const worstThree = [...perOpponent]
        .sort((a, b) => a.recall - b.recall)
        .slice(0, 3)
        .map((o) => `${o.id}=${fmtPct(o.recall)}`)
        .join(', ');

      verdict = {
        id: 'b7',
        title: 'Leak recall sanity (CQ-2)',
        status: rollup([recallOk, enoughOpponents]),
        headline: `Recall ${fmtPct(recall)} across ${perOpponent.length} opponents; lowest: ${worstThree || 'n/a'}`,
        criteria,
        source: { artifact: 'apps/workers/src/eval/fixtures/leak-eval/recall.json', runAt },
        generatedAt: new Date().toISOString(),
      };
    }
  } catch (err) {
    verdict = errorVerdict('b7', 'Leak recall sanity (CQ-2)', err);
  }

  const written = writeVerdict(verdict);
  logVerdict(verdict);
  console.log(`[b7] verdict written to ${written}`);
  if (verdict.status === 'fail') process.exit(1);
}

main();
