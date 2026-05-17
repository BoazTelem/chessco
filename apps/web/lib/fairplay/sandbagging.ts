/**
 * Sandbagging detection. Spec §12.
 *
 * Two patterns we flag:
 *   1. **Rating velocity**: a new account that climbs faster than physically
 *      plausible (>200 Glicko-2 in a week is suspicious; >400 is alarm).
 *   2. **External-rating divergence**: a player's Chessco rating drifts more
 *      than 1.5× below their verified external rating. That gap suggests
 *      the user deliberately loses early matches to inflate their next
 *      opponent's expected score and trigger oversized payouts.
 *
 * Pure function.
 */

export interface SandbaggingInputs {
  accountAgeDays: number;
  ratingNow: number;
  ratingDeltaPast7Days: number;
  externalRating: number | null;
  paidGamesCompleted: number;
}

export interface SandbaggingVerdict {
  severity: 0 | 1 | 2 | 3 | 4;
  signals: string[];
}

/** Spec §12 cap: Chessco rating cannot exceed external rating × 1.5. */
const EXTERNAL_CAP_MULTIPLIER = 1.5;

export function analyzeSandbagging(inputs: SandbaggingInputs): SandbaggingVerdict {
  const signals: string[] = [];
  let severity: SandbaggingVerdict['severity'] = 0;

  // Pattern 1: rating velocity. Only fires for fresh accounts; established
  // accounts can climb fast legitimately on a learning curve.
  if (inputs.accountAgeDays <= 30) {
    if (inputs.ratingDeltaPast7Days > 400) {
      signals.push(`+${inputs.ratingDeltaPast7Days} in 7d on a ${inputs.accountAgeDays}d account`);
      severity = Math.max(severity, 3) as SandbaggingVerdict['severity'];
    } else if (inputs.ratingDeltaPast7Days > 200) {
      signals.push(`+${inputs.ratingDeltaPast7Days} in 7d on a ${inputs.accountAgeDays}d account`);
      severity = Math.max(severity, 1) as SandbaggingVerdict['severity'];
    }
  }

  // Pattern 2: external rating divergence (drifting DOWN — sandbagging).
  if (inputs.externalRating !== null) {
    const cap = Math.round(inputs.externalRating * EXTERNAL_CAP_MULTIPLIER);
    const floor = Math.round(inputs.externalRating / EXTERNAL_CAP_MULTIPLIER);

    // Drifting above cap is the same engine-assistance pattern from a
    // different angle; surface it.
    if (inputs.ratingNow > cap) {
      signals.push(
        `Chessco ${inputs.ratingNow} > ${EXTERNAL_CAP_MULTIPLIER}× external ${inputs.externalRating}`,
      );
      severity = Math.max(severity, 4) as SandbaggingVerdict['severity'];
    } else if (inputs.ratingNow < floor && inputs.paidGamesCompleted >= 5) {
      signals.push(`Chessco ${inputs.ratingNow} < external/${EXTERNAL_CAP_MULTIPLIER} = ${floor}`);
      severity = Math.max(severity, 2) as SandbaggingVerdict['severity'];
    }
  }

  if (signals.length === 0) {
    signals.push('within normal velocity + external-rating bounds');
  }
  return { severity, signals };
}
