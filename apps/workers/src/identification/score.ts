/**
 * Confidence scoring for Stage 2 handle candidates.
 *
 * A score is a value in [0, 1] = weighted sum of signals:
 *   - name_similarity  (trigram score)          weight 0.50
 *   - country_match    (1 if matches, 0 else)   weight 0.20
 *   - rating_band      (1 if within band, 0)    weight 0.20
 *   - title_match      (1 if titled, 0)         weight 0.10
 *
 * Pattern bonus (last-name-only, first_last, etc.) is folded into the
 * name_similarity term so canonical patterns don't get penalized for
 * being short.
 */

export interface ScoreInput {
  name_similarity: number; // 0..1
  country_match: boolean | null; // null = no info to compare
  rating_band_match: boolean | null;
  title_match: boolean | null;
  /** Multiplier on the rating component's weight when the rating signal is
   *  softer than a FIDE rating (e.g. user-supplied estimate on an ad-hoc
   *  anchor). Default 1.0 (full weight). Set to ~0.85 for 'user_estimate'. */
  rating_weight_multiplier?: number;
}

export interface ScoreOutput {
  confidence: number; // 0..1
  reasons: string[];
}

export function score(input: ScoreInput): ScoreOutput {
  const reasons: string[] = [];
  const ratingMul = input.rating_weight_multiplier ?? 1;

  // Renormalize weights based on which signals we have data for.
  const weights = {
    name: 0.5,
    country: input.country_match === null ? 0 : 0.2,
    rating: input.rating_band_match === null ? 0 : 0.2 * ratingMul,
    title: input.title_match === null ? 0 : 0.1,
  };
  const totalWeight = weights.name + weights.country + weights.rating + weights.title;
  if (totalWeight === 0) return { confidence: 0, reasons };

  let raw = 0;
  raw += weights.name * Math.min(1, Math.max(0, input.name_similarity));
  reasons.push(`name match ${(input.name_similarity * 100).toFixed(0)}%`);

  if (input.country_match === true) {
    raw += weights.country;
    reasons.push('country matches');
  } else if (input.country_match === false) {
    reasons.push('country MISMATCH');
  }

  if (input.rating_band_match === true) {
    raw += weights.rating;
    reasons.push(ratingMul < 1 ? 'rating in estimated band' : 'rating in band');
  } else if (input.rating_band_match === false) {
    reasons.push(ratingMul < 1 ? 'rating outside estimated band' : 'rating outside band');
  }

  if (input.title_match === true) {
    raw += weights.title;
    reasons.push('titled');
  }

  return { confidence: raw / totalWeight, reasons };
}

/**
 * Ad-hoc-anchor variant of ratingBandMatch. The user supplied a band on
 * the OTB-equivalent scale they think the opponent plays at — no FIDE→
 * online offset to apply. Match if ANY online rating across the four
 * time controls falls inside [low, high].
 */
export function ratingBandMatchExplicit(
  band: { low: number; high: number },
  online: {
    bullet?: number | null;
    blitz?: number | null;
    rapid?: number | null;
    classical?: number | null;
  },
): boolean | null {
  const ratings = [online.bullet, online.blitz, online.rapid, online.classical].filter(
    (r): r is number => typeof r === 'number',
  );
  if (ratings.length === 0) return null;
  return ratings.some((r) => r >= band.low && r <= band.high);
}

/**
 * Absolute confidence boost (added to the weighted-sum score) based on
 * how well the candidate's self-reported FIDE rating matches the anchor's.
 * This is qualitatively sharper than the rating-band signal — the
 * candidate themselves is claiming a specific FIDE number — so it
 * functions as a tiebreaker on top of the main score, not as a fifth
 * weighted component.
 *
 * Returns:
 *   +0.10  tight match  (|claimed - anchor| ≤ 50)
 *   +0.05  loose match  (51 ≤ |claimed - anchor| ≤ 150)
 *    0     no signal    (claimed absent OR anchor absent)
 *   -0.10  clear mismatch (|claimed - anchor| > 250)
 *
 * Anchor can be either a FIDE rating (federation-anchored query) or the
 * midpoint of a user-supplied rating band (ad-hoc query); both are on
 * the OTB-equivalent scale and compare to claimed_fide_rating directly.
 */
export function claimedFideRatingBoost(
  anchorRating: number | null | undefined,
  claimedFide: number | null | undefined,
): number {
  if (anchorRating == null || claimedFide == null) return 0;
  const gap = Math.abs(claimedFide - anchorRating);
  if (gap <= 50) return 0.1;
  if (gap <= 150) return 0.05;
  if (gap > 250) return -0.1;
  return 0;
}

/**
 * Are the candidate's online ratings within the rating band of fideStandard?
 * Rapid/blitz online runs higher than FIDE standard, so we widen the band.
 *
 * Returns null if we have neither fideStandard nor any online rating.
 */
export function ratingBandMatch(
  fideStandard: number | null | undefined,
  online: {
    bullet?: number | null;
    blitz?: number | null;
    rapid?: number | null;
    classical?: number | null;
  },
  band = 400,
): boolean | null {
  if (fideStandard == null) return null;
  const ratings = [online.bullet, online.blitz, online.rapid, online.classical].filter(
    (r): r is number => typeof r === 'number',
  );
  if (ratings.length === 0) return null;
  // Online ratings tend to run 100-200 higher than FIDE standard.
  // Match if ANY online rating is within `band` points of fide + 150 (mid offset).
  const offset = 150;
  return ratings.some((r) => Math.abs(r - (fideStandard + offset)) <= band);
}
