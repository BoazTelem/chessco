/**
 * Synthesize likely platform-handle candidates from a FIDE name.
 *
 * The chess.com country crawler caps at ~10k handles per ISO (upstream
 * limit), so most real players aren't in our corpus. When a user clicks
 * "Find their online accounts" on a profile, we probe a small set of
 * obvious handle constructions in parallel — pure-function synthesizer
 * here, network code in lazy-probe.ts.
 *
 * Output order is the probe order; common conventions first
 * (given+surname > surname+given > separator variants > digit suffix).
 */

const SEPARATORS = ['', '_', '.', '-'];

function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalizeToken(s: string): string {
  return stripDiacritics(s)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Parse a FIDE-style name into given + surname. Handles "Surname, Given"
 * (comma form, the FIDE canonical) and "Given Surname" (free-text form).
 * Multi-word surnames are concatenated ("Vachier-Lagrave" → "vachierlagrave").
 */
export function splitFideName(raw: string): { given: string; surname: string } | null {
  const cleaned = raw.trim();
  if (!cleaned) return null;
  if (cleaned.includes(',')) {
    const [surnamePart, givenPart] = cleaned.split(',', 2).map((t) => t.trim());
    if (!surnamePart || !givenPart) return null;
    const given = normalizeToken((givenPart.split(/\s+/)[0] ?? '').trim());
    const surname = normalizeToken(surnamePart);
    return { given, surname };
  }
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) {
    return { given: '', surname: normalizeToken(parts[0]!) };
  }
  const given = normalizeToken(parts[0]!);
  const surname = normalizeToken(parts.slice(1).join(''));
  return { given, surname };
}

/**
 * Generate candidate handles to probe. Capped to `limit` (default 18 — keeps
 * the chess.com fan-out at one server-side burst that doesn't trip 429s).
 */
export function synthesizeHandleCandidates(
  rawName: string,
  birthYear?: number | null,
  limit = 18,
): string[] {
  const parsed = splitFideName(rawName);
  if (!parsed) return [];
  const { given, surname } = parsed;

  const out = new Set<string>();

  if (!given || !surname) {
    const base = given || surname;
    if (!base || base.length < 3) return [];
    out.add(base);
    out.add(`${base}1`);
    out.add(`${base}chess`);
    if (birthYear) out.add(`${base}${String(birthYear).slice(-2)}`);
  } else {
    // given+surname first (chess.com convention "magnuscarlsen"), then
    // surname+given (less common but real — e.g. "carlsenmagnus").
    for (const [a, b] of [
      [given, surname],
      [surname, given],
    ]) {
      for (const sep of SEPARATORS) {
        const base = `${a}${sep}${b}`;
        out.add(base);
        out.add(`${base}1`);
      }
    }
    if (birthYear) {
      const yy = String(birthYear).slice(-2);
      out.add(`${given}${surname}${yy}`);
      out.add(`${surname}${given}${yy}`);
    }
  }

  return Array.from(out)
    .filter((h) => h.length >= 4 && h.length <= 30)
    .slice(0, limit);
}
