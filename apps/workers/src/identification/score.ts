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
}

export interface ScoreOutput {
  confidence: number; // 0..1
  reasons: string[];
}

export function score(input: ScoreInput): ScoreOutput {
  const reasons: string[] = [];

  // Renormalize weights based on which signals we have data for.
  const weights = {
    name: 0.5,
    country: input.country_match === null ? 0 : 0.2,
    rating: input.rating_band_match === null ? 0 : 0.2,
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
    reasons.push('rating in band');
  } else if (input.rating_band_match === false) {
    reasons.push('rating outside band');
  }

  if (input.title_match === true) {
    raw += weights.title;
    reasons.push('titled');
  }

  return { confidence: raw / totalWeight, reasons };
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
