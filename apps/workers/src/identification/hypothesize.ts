/**
 * Generate plausible online-handle variants from a federation player's
 * normalized name, country, and birth year. Output is fed into:
 *   1. cached-match.ts — search platform_players for trigram hits
 *   2. probe.ts — for hypothesized handles not yet in the cache, hit the
 *      respective API to check for existence.
 *
 * Heuristics are conservative: we generate the ~20 most common patterns
 * (last, first, first_last, last_first, initial+last, last+initial,
 * with/without year/country). Famous-player aliases like "_real" or
 * "_official" are NOT generated — too noisy at scale.
 */
import { normalizeName } from '../fide/normalize';

export interface HypothesizeInput {
  /** "Lastname, Firstname" (FIDE-style) or already-normalized. */
  name: string;
  country?: string | null;
  birth_year?: number | null;
}

export interface Hypothesis {
  handle: string;
  /** Compact rationale, useful for debugging / evidence prose. */
  pattern: string;
}

const STOP_WORDS = new Set(['jr', 'sr', 'iii', 'ii', 'iv']);

export function hypothesizeHandles(input: HypothesizeInput): Hypothesis[] {
  const tokens = normalizeName(input.name)
    .split(/[\s,]+/)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));

  if (tokens.length === 0) return [];

  // FIDE format is "lastname firstname [middle...]" after normalization.
  // If only one token, treat it as last name.
  const last = tokens[0]!;
  const first = tokens[1] ?? null;
  const firstInitial = first ? first[0]! : null;

  const country = input.country?.toLowerCase() ?? null;
  const birthYear = input.birth_year ?? null;
  const yyShort = birthYear !== null ? String(birthYear).slice(2) : null;
  const yyFull = birthYear !== null ? String(birthYear) : null;

  const out: Hypothesis[] = [];
  const seen = new Set<string>();
  const add = (handle: string, pattern: string) => {
    if (handle.length < 3 || handle.length > 25) return;
    if (seen.has(handle)) return;
    seen.add(handle);
    out.push({ handle, pattern });
  };

  // Single names — strongest signals first.
  add(last, 'last');
  if (first) add(first, 'first');

  // Last + first combinations.
  if (first) {
    add(`${first}${last}`, 'firstlast');
    add(`${first}_${last}`, 'first_last');
    add(`${first}-${last}`, 'first-last');
    add(`${last}${first}`, 'lastfirst');
    add(`${last}_${first}`, 'last_first');
    add(`${last}-${first}`, 'last-first');
  }

  // Initial + last.
  if (firstInitial) {
    add(`${firstInitial}${last}`, 'I+last');
    add(`${firstInitial}_${last}`, 'I_last');
    add(`${last}${firstInitial}`, 'last+I');
    add(`${last}_${firstInitial}`, 'last_I');
  }

  // Birth year variants.
  if (yyShort) {
    add(`${last}${yyShort}`, 'last+YY');
    add(`${last}_${yyShort}`, 'last_YY');
    if (first) {
      add(`${first}${last}${yyShort}`, 'firstlast+YY');
      add(`${first}_${last}_${yyShort}`, 'first_last_YY');
    }
  }
  if (yyFull && yyFull !== yyShort) {
    add(`${last}${yyFull}`, 'last+YYYY');
    add(`${last}_${yyFull}`, 'last_YYYY');
  }

  // Country variants.
  if (country) {
    add(`${last}${country}`, 'last+country');
    add(`${last}_${country}`, 'last_country');
    if (first) {
      add(`${first}_${last}_${country}`, 'first_last_country');
    }
  }

  return out;
}
