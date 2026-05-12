/**
 * Normalize a real name claimed by a platform profile (chess.com `name`
 * or Lichess `profile.realName`) into the same shape used by
 * federation_players.name_normalized, so trigram fuzzy match works:
 *
 *   "Boris Kantsler"   → "boris kantsler"
 *   "García, José M."  → "garcia jose m"
 *   "Çağdaş Onur"      → "cagdas onur"
 *
 * Distinct from FIDE's "lastname firstname" convention — we keep
 * whatever order the platform gave us. pg_trgm similarity is
 * order-tolerant (matches share trigrams either way).
 */
export function normalizeClaimedName(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  return trimmed
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining marks
    .toLowerCase()
    .replace(/[',.()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
