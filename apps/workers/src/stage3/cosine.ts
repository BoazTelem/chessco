/**
 * Cosine similarity over sparse {key → count} distributions.
 *
 * Treats each Record<string, number> as a sparse vector and computes
 *   dot / (|a| × |b|)
 *
 * Range: [0, 1] for non-negative inputs (which all our distributions are).
 * Returns 0 if either side is empty (no shared dimensions).
 */
export function cosineSparse(a: Record<string, number>, b: Record<string, number>): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const k in a) {
    const av = a[k] ?? 0;
    magA += av * av;
    const bv = b[k];
    if (bv !== undefined) dot += av * bv;
  }
  for (const k in b) {
    const bv = b[k] ?? 0;
    magB += bv * bv;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Gaussian falloff for scalar features (avg_opponent_rating).
 *   sigma = 200 means a 200-point gap halves the similarity.
 */
export function gaussianScalar(a: number | null, b: number | null, sigma = 200): number {
  if (a === null || b === null) return 0;
  const diff = a - b;
  return Math.exp(-(diff * diff) / (2 * sigma * sigma));
}
