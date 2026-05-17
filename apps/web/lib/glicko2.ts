/**
 * Glicko-2 rating update (Glickman, 2012). Pure functions; no DB.
 *
 * Spec §9: per-time-class rating maintained in `ratings_by_time_class`.
 * Callers should:
 *   1. Load current { rating, rd, volatility } for each player.
 *   2. Call updatePair(...) with the match result.
 *   3. Persist the returned values; insert a row into rating_history.
 *
 * Constants follow Glickman's paper. System constant τ = 0.5 — moderate
 * change rate for a competitive rating ladder. Lower τ (e.g. 0.3) damps
 * volatility for established players; higher τ (0.8+) lets a player
 * climb faster but tracks short streaks too aggressively.
 *
 * The whole module is provider- and DB-agnostic, exercised by unit tests
 * in apps/workers/src/eval/ws9-libs.test.ts (surface audit).
 */

const SYSTEM_TAU = 0.5;
const CONVERGENCE_EPSILON = 0.000_001;
const GLICKO_SCALE = 173.7178;
const GLICKO_BASE = 1500;

export interface GlickoRating {
  rating: number;
  rd: number; // rating deviation
  volatility: number;
}

export interface MatchOutcome {
  /** Score from the player's perspective: 1 win, 0.5 draw, 0 loss. */
  score: 0 | 0.5 | 1;
}

/** Glicko-2 internal "μ" / "φ" representation. */
function toGlicko2(r: GlickoRating): { mu: number; phi: number; sigma: number } {
  return {
    mu: (r.rating - GLICKO_BASE) / GLICKO_SCALE,
    phi: r.rd / GLICKO_SCALE,
    sigma: r.volatility,
  };
}

function fromGlicko2(mu: number, phi: number, sigma: number): GlickoRating {
  return {
    rating: mu * GLICKO_SCALE + GLICKO_BASE,
    rd: phi * GLICKO_SCALE,
    volatility: sigma,
  };
}

function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

function E(mu: number, muOpp: number, phiOpp: number): number {
  return 1 / (1 + Math.exp(-g(phiOpp) * (mu - muOpp)));
}

function updateVolatility(args: { phi: number; sigma: number; delta: number; v: number }): number {
  const { phi, sigma, delta, v } = args;
  const a = Math.log(sigma * sigma);
  const f = (x: number): number => {
    const ex = Math.exp(x);
    const num = ex * (delta * delta - phi * phi - v - ex);
    const den = 2 * (phi * phi + v + ex) ** 2;
    return num / den - (x - a) / (SYSTEM_TAU * SYSTEM_TAU);
  };
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * SYSTEM_TAU) < 0) k++;
    B = a - k * SYSTEM_TAU;
  }
  let fA = f(A);
  let fB = f(B);
  let iterations = 0;
  while (Math.abs(B - A) > CONVERGENCE_EPSILON && iterations < 100) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
    iterations++;
  }
  return Math.exp(A / 2);
}

/**
 * Compute the new rating + RD + volatility for one player given their
 * opponent and an outcome. The opponent's rating is NOT updated by this
 * call — call once per player.
 *
 * For batch periods (multiple games against multiple opponents), use
 * updateBatched(); this function is the single-game special case.
 */
export function updateSingle(
  player: GlickoRating,
  opponent: GlickoRating,
  outcome: MatchOutcome,
): GlickoRating {
  return updateBatched(player, [{ opponent, outcome }]);
}

export function updateBatched(
  player: GlickoRating,
  games: Array<{ opponent: GlickoRating; outcome: MatchOutcome }>,
): GlickoRating {
  if (games.length === 0) {
    // Glicko-2 "did not compete" branch: only RD increases.
    const p = toGlicko2(player);
    const newPhi = Math.sqrt(p.phi * p.phi + p.sigma * p.sigma);
    return fromGlicko2(p.mu, newPhi, p.sigma);
  }
  const p = toGlicko2(player);
  let vInv = 0;
  let deltaSum = 0;
  for (const { opponent, outcome } of games) {
    const o = toGlicko2(opponent);
    const gPhi = g(o.phi);
    const expected = E(p.mu, o.mu, o.phi);
    vInv += gPhi * gPhi * expected * (1 - expected);
    deltaSum += gPhi * (outcome.score - expected);
  }
  const v = 1 / vInv;
  const delta = v * deltaSum;
  const newSigma = updateVolatility({ phi: p.phi, sigma: p.sigma, delta, v });
  const phiStar = Math.sqrt(p.phi * p.phi + newSigma * newSigma);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = p.mu + newPhi * newPhi * deltaSum;
  return fromGlicko2(newMu, newPhi, newSigma);
}

/**
 * Convenience: update both players from a single game. Each player's new
 * rating is computed using the OLD opponent rating (canonical Glicko-2
 * behavior — both players update against pre-match values).
 */
export function updatePair(
  white: GlickoRating,
  black: GlickoRating,
  result: '1-0' | '0-1' | '1/2-1/2',
): { white: GlickoRating; black: GlickoRating } {
  let whiteScore: MatchOutcome['score'];
  let blackScore: MatchOutcome['score'];
  switch (result) {
    case '1-0':
      whiteScore = 1;
      blackScore = 0;
      break;
    case '0-1':
      whiteScore = 0;
      blackScore = 1;
      break;
    case '1/2-1/2':
      whiteScore = 0.5;
      blackScore = 0.5;
      break;
  }
  return {
    white: updateSingle(white, black, { score: whiteScore }),
    black: updateSingle(black, white, { score: blackScore }),
  };
}

/** Default Glicko-2 starting rating for a brand-new player. */
export const NEW_PLAYER: GlickoRating = {
  rating: 1500,
  rd: 350,
  volatility: 0.06,
};
