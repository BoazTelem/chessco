/**
 * Name normalization for fuzzy trigram search.
 *
 * Spec §4 of fide-ingestion-spec.md:
 *   "Carlsen, Magnus" → "carlsen magnus"
 *   "García, José M." → "garcia jose m"
 *   "O'Brien, Patrick" → "obrien patrick"
 *   "Çağdaş, Onur" → "cagdas onur"
 *
 * Steps:
 *   1. Unicode NFD-normalize, strip combining marks
 *   2. Lowercase
 *   3. Strip apostrophes, periods, commas
 *   4. Collapse whitespace
 *   5. Trim
 */
export function normalizeName(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritical marks
    .toLowerCase()
    .replace(/[',.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * FIDE publishes titles in multiple fields (title, w_title, o_title, foa_title).
 * Use this precedence (spec §4):
 *   GM > WGM > IM > WIM > FM > WFM > CM > WCM > NM > WNM > (empty)
 */
const TITLE_PRECEDENCE = ['GM', 'WGM', 'IM', 'WIM', 'FM', 'WFM', 'CM', 'WCM', 'NM', 'WNM'] as const;

export function pickBestTitle(titles: (string | null | undefined)[]): string | null {
  const present = titles.filter((t): t is string => typeof t === 'string' && t.length > 0);
  for (const candidate of TITLE_PRECEDENCE) {
    if (present.includes(candidate)) return candidate;
  }
  return null;
}

/**
 * FIDE ratings outside [1000, 3000] are implausible; we still store them but
 * log a warning to the run metrics.
 */
export function isImplausibleRating(rating: number | null | undefined): boolean {
  if (rating == null) return false;
  return rating < 1000 || rating > 3000;
}

/**
 * Parse FIDE birthday field: usually a 4-digit year, sometimes blank.
 */
export function parseBirthYear(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const year = parseInt(raw.trim(), 10);
  if (!Number.isFinite(year)) return null;
  const currentYear = new Date().getFullYear();
  if (year < 1900 || year > currentYear) return null;
  return year;
}
