/**
 * Engine-correlation analyzer. Spec §12.
 *
 * Input: per-ply engine matches at three depths (12 / 18 / 25) and the
 * player's rating. Output: a flag verdict (severity 0..6) with a
 * structured signals payload.
 *
 * Why three depths: a player using a low-depth engine (Stockfish d12)
 * matches the d12 line at ~95% but the d25 line only weakly; a player
 * using a deep engine matches all three. A clean player matches all
 * three near the rating-band baseline. The depth fingerprint helps
 * triage *which* engine is being used.
 *
 * Pure function; no DB. Caller fetches the engine matches via the
 * existing Stockfish worker (apps/workers/src/stockfish/) and persists
 * the verdict into `fairplay_flags` if severity > 0.
 */
import { baselineForRating } from './baselines';

export interface DepthMatches {
  /** Plies analyzed at this depth (after `start_ply`). */
  pliesAnalyzed: number;
  /** Plies where the player's move == engine's top-1 move at this depth. */
  matches: number;
}

export interface EngineCorrelationInputs {
  playerRating: number | null;
  /** Time class affects evidence weight — bullet allows fast top-1 by intuition. */
  timeClass: 'bullet' | 'blitz' | 'rapid' | 'classical';
  depths: { d12: DepthMatches; d18: DepthMatches; d25: DepthMatches };
}

export interface CorrelationVerdict {
  severity: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  rule: 'clean' | 'over_p99' | 'over_p99_with_depth_signature' | 'extreme_over_p99';
  observed: {
    d12Rate: number;
    d18Rate: number;
    d25Rate: number;
  };
  baseline: { p50: number; p90: number; p99: number };
  /** Free-form notes for the admin reviewer. */
  notes: string[];
}

function rate(d: DepthMatches): number {
  if (d.pliesAnalyzed === 0) return 0;
  return d.matches / d.pliesAnalyzed;
}

const MIN_PLIES_FOR_VERDICT = 12;

/**
 * Bullet games tolerate higher match rates because strong intuitive play
 * looks identical to engine top-1 at d12. Add a flat per-time-class
 * cushion to the p99 baseline.
 */
const TIME_CLASS_CUSHION: Record<EngineCorrelationInputs['timeClass'], number> = {
  bullet: 0.08,
  blitz: 0.05,
  rapid: 0.02,
  classical: 0.0,
};

export function analyzeEngineCorrelation(inputs: EngineCorrelationInputs): CorrelationVerdict {
  const baseline = baselineForRating(inputs.playerRating);
  const cushion = TIME_CLASS_CUSHION[inputs.timeClass];
  const adjustedP99 = baseline.p99 + cushion;

  const d12Rate = rate(inputs.depths.d12);
  const d18Rate = rate(inputs.depths.d18);
  const d25Rate = rate(inputs.depths.d25);

  const observed = { d12Rate, d18Rate, d25Rate };
  const notes: string[] = [];

  const totalPlies = inputs.depths.d18.pliesAnalyzed;
  if (totalPlies < MIN_PLIES_FOR_VERDICT) {
    notes.push(
      `insufficient evidence: only ${totalPlies} d18 plies analyzed (min ${MIN_PLIES_FOR_VERDICT})`,
    );
    return { severity: 0, rule: 'clean', observed, baseline, notes };
  }

  // Primary signal is d18 — that's the "production" depth from spec.
  if (d18Rate <= adjustedP99) {
    notes.push(
      `d18 rate ${(d18Rate * 100).toFixed(1)}% within band ≤ ${(adjustedP99 * 100).toFixed(1)}%`,
    );
    return { severity: 0, rule: 'clean', observed, baseline, notes };
  }

  // Depth signature: a clear engine fingerprint shows up when d12 and
  // d25 rates are BOTH significantly elevated. If d12 is up but d25 is
  // flat, the player is probably running a shallow engine.
  const depthSignature = d12Rate > baseline.p99 && d25Rate > baseline.p99 - 0.05;

  const overshoot = d18Rate - adjustedP99;

  if (overshoot >= 0.15) {
    notes.push(
      `extreme overshoot: d18 ${(d18Rate * 100).toFixed(1)}% vs p99+cushion ${(adjustedP99 * 100).toFixed(1)}%`,
    );
    return {
      severity: depthSignature ? 6 : 5,
      rule: 'extreme_over_p99',
      observed,
      baseline,
      notes,
    };
  }

  if (overshoot >= 0.08) {
    notes.push(`material overshoot ${(overshoot * 100).toFixed(1)}% above p99+cushion`);
    return {
      severity: depthSignature ? 5 : 4,
      rule: depthSignature ? 'over_p99_with_depth_signature' : 'over_p99',
      observed,
      baseline,
      notes,
    };
  }

  // Marginal overshoot — warning territory, not a ban.
  notes.push(
    `marginal overshoot ${(overshoot * 100).toFixed(1)}% above p99+cushion; needs corroboration`,
  );
  return {
    severity: depthSignature ? 3 : 2,
    rule: depthSignature ? 'over_p99_with_depth_signature' : 'over_p99',
    observed,
    baseline,
    notes,
  };
}
