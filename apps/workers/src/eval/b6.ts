/**
 * B6 — Leak precision@5 verdict (CQ-2).
 *
 * Reads a labeled-leak dataset at
 *   apps/workers/src/eval/fixtures/leak-eval/precision.json
 * and computes the precision of the top-5 surfaced leaks against the
 * ground-truth labels.
 *
 * Dataset shape (per fixtures/leak-eval/README.md):
 *   {
 *     opponents: [
 *       {
 *         opponent_id: "platform:handle",
 *         user_color: "white" | "black",
 *         surfaced_leaks: [
 *            { fen_key, user_move_uci, opp_move_uci,
 *              eval_after_user, opp_winrate_from_position }
 *         ],
 *         // Per-leak pass criterion: eval >= 0.4 AND opp_winrate <= 0.35.
 *       }
 *     ],
 *     // measured on production data, not synthesized here
 *   }
 *
 * If the dataset is missing, emits a pending verdict — same pattern as
 * B11 before WS-3 landed prompts. Operator curates dataset in production
 * via `apps/workers/scripts/leaks-smoke.ts` (already present).
 *
 *   pnpm --filter @chessco/workers bench:b6
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

interface SurfacedLeak {
  fen_key: string;
  user_move_uci: string;
  opp_move_uci: string;
  eval_after_user: number;
  opp_winrate_from_position: number;
}

interface OpponentEval {
  opponent_id: string;
  user_color: 'white' | 'black';
  surfaced_leaks: SurfacedLeak[];
}

interface PrecisionArtifact {
  generated_at: string;
  opponents: OpponentEval[];
}

function leakPasses(leak: SurfacedLeak, userColor: 'white' | 'black'): boolean {
  // Plan spec: top-5 leak must have eval ≥ +0.4 for the user's color AND
  // opponent historical performance ≤ 35% from that position.
  const signedEval = userColor === 'white' ? leak.eval_after_user : -leak.eval_after_user;
  return signedEval >= 0.4 && leak.opp_winrate_from_position <= 0.35;
}

function main(): void {
  let verdict: Verdict;
  try {
    const loaded = readArtifact<PrecisionArtifact>(
      'apps/workers/src/eval/fixtures/leak-eval/precision.json',
    );
    if (!loaded) {
      verdict = pendingVerdict(
        'b6',
        'Leak precision@5 (CQ-2)',
        'No leak-precision dataset published yet. Curate via apps/workers/scripts/leaks-smoke.ts ' +
          'and drop the result at apps/workers/src/eval/fixtures/leak-eval/precision.json.',
      );
    } else {
      const { data, runAt } = loaded;
      let totalSurfaced = 0;
      let totalPasses = 0;
      let oppWithLeaks = 0;
      const perOpponent: Array<{ id: string; precision: number; n: number }> = [];

      for (const opp of data.opponents) {
        const top5 = opp.surfaced_leaks.slice(0, 5);
        if (top5.length === 0) continue;
        oppWithLeaks++;
        const passes = top5.filter((l) => leakPasses(l, opp.user_color)).length;
        totalSurfaced += top5.length;
        totalPasses += passes;
        perOpponent.push({ id: opp.opponent_id, precision: passes / top5.length, n: top5.length });
      }

      const precision = totalSurfaced > 0 ? totalPasses / totalSurfaced : 0;
      const precisionOk = precision >= CQ2_CRITERIA.precisionAt5;
      const enoughOpponents = oppWithLeaks >= 10;

      const criteria = [
        {
          label: 'Aggregate precision@5',
          threshold: `≥ ${fmtPct(CQ2_CRITERIA.precisionAt5)}`,
          actual: `${fmtPct(precision)} (${totalPasses}/${totalSurfaced})`,
          passed: precisionOk,
        },
        {
          label: 'Opponents with ≥1 surfaced leak',
          threshold: '≥ 10',
          actual: oppWithLeaks.toString(),
          passed: enoughOpponents,
        },
      ];

      const worstThree = [...perOpponent]
        .sort((a, b) => a.precision - b.precision)
        .slice(0, 3)
        .map((o) => `${o.id}=${fmtPct(o.precision)}`)
        .join(', ');

      verdict = {
        id: 'b6',
        title: 'Leak precision@5 (CQ-2)',
        status: rollup([precisionOk, enoughOpponents]),
        headline: `Precision ${fmtPct(precision)} across ${oppWithLeaks} opponents; lowest: ${worstThree || 'n/a'}`,
        criteria,
        source: {
          artifact: 'apps/workers/src/eval/fixtures/leak-eval/precision.json',
          runAt,
        },
        generatedAt: new Date().toISOString(),
      };
    }
  } catch (err) {
    verdict = errorVerdict('b6', 'Leak precision@5 (CQ-2)', err);
  }

  const written = writeVerdict(verdict);
  logVerdict(verdict);
  console.log(`[b6] verdict written to ${written}`);
  if (verdict.status === 'fail') process.exit(1);
}

main();
