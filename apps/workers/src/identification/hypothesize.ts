/**
 * Generate plausible online-handle variants from a federation player's
 * normalized name, country, and birth year. Output is fed into:
 *   1. cached-match.ts — search platform_players for trigram hits
 *   2. probe.ts — for hypothesized handles not yet in the cache, hit the
 *      respective API to check for existence.
 *
 * v2 (sprint lever 2): broadened variant generation:
 *   - common English nickname mapping (William → bill/will/liam, etc.)
 *   - federation-conventional suffixes (`_chess`, `chess`)
 *   - DOB-prefixed variants on first name as well as last
 *   - country-code suffix applied to first+last pattern
 *   - simple transliteration alternates for Cyrillic/Greek-origin spellings
 *
 * Ordering preserves "strongest signals first" so callers that slice the
 * top-N still pick high-likelihood variants.
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

/**
 * Common nickname mappings. Keyed by the canonical first name (post-normalize).
 * Kept conservative: only well-known shortenings that real handles actually use.
 */
const NICKNAMES: Record<string, string[]> = {
  alexander: ['alex', 'sasha', 'sasha', 'sanya'],
  aleksander: ['alex', 'sasha'],
  aleksandr: ['alex', 'sasha'],
  alexandra: ['alex', 'sasha'],
  alexei: ['alex', 'lesha'],
  alexey: ['alex', 'lesha'],
  anatoly: ['tolya'],
  anastasia: ['nastya'],
  andrew: ['andy', 'drew'],
  andrey: ['andrei', 'andy'],
  andrei: ['andrey', 'andy'],
  anthony: ['tony'],
  benjamin: ['ben', 'benny'],
  catherine: ['cathy', 'kate'],
  charles: ['charlie', 'chuck'],
  christopher: ['chris'],
  christian: ['chris'],
  daniel: ['dan', 'danny'],
  david: ['dave'],
  dmitry: ['dima'],
  dmitri: ['dima'],
  edward: ['ed', 'eddie', 'ted'],
  elizabeth: ['liz', 'beth', 'ellie'],
  emmanuel: ['manu'],
  evgeny: ['zhenya'],
  evgeniy: ['zhenya'],
  francisco: ['paco', 'fran'],
  frederick: ['fred', 'freddie'],
  fredrik: ['fred'],
  gabriel: ['gabe'],
  george: ['georgie'],
  ivan: ['vanya'],
  jacob: ['jake'],
  james: ['jim', 'jimmy', 'jamie'],
  jeffrey: ['jeff'],
  jennifer: ['jen', 'jenny'],
  john: ['johnny', 'jack'],
  jonathan: ['jon', 'jonny'],
  joseph: ['joe', 'joey'],
  joshua: ['josh'],
  katherine: ['kate', 'kathy'],
  konstantin: ['kostya'],
  leonardo: ['leo'],
  magnus: ['magnus'],
  margaret: ['maggie', 'meg'],
  matthew: ['matt'],
  michael: ['mike', 'mikey'],
  mikhail: ['misha'],
  natalia: ['natasha', 'nata'],
  natalya: ['natasha', 'nata'],
  natalie: ['nat'],
  nicholas: ['nick'],
  nikolai: ['kolya'],
  nikolay: ['kolya'],
  oleksandr: ['alex', 'sasha'],
  pavel: ['pasha'],
  patrick: ['pat'],
  peter: ['pete'],
  rebecca: ['becky'],
  richard: ['rick', 'dick'],
  robert: ['rob', 'bob', 'bobby'],
  ronald: ['ron', 'ronnie'],
  samuel: ['sam', 'sammy'],
  sergey: ['sergei', 'seryozha', 'sergio'],
  sergei: ['sergey', 'seryozha'],
  stephen: ['steve'],
  steven: ['steve'],
  sviatoslav: ['slava'],
  svyatoslav: ['slava'],
  thomas: ['tom', 'tommy'],
  timothy: ['tim'],
  vasily: ['vasya'],
  vasiliy: ['vasya'],
  viktor: ['vitya', 'victor'],
  victor: ['viktor', 'vic'],
  vladimir: ['vova', 'volodya'],
  vyacheslav: ['slava'],
  william: ['will', 'bill', 'liam', 'billy'],
  yaroslav: ['yarik'],
  yevgeny: ['zhenya'],
  yury: ['yura'],
  yuri: ['yura'],
};

/**
 * Last-name transliteration alternates. Only patterns that actually conflict
 * across romanization systems; we don't try to be exhaustive.
 */
const TRANSLIT_RULES: Array<[RegExp, string]> = [
  [/ya$/, 'ia'], // -ya / -ia (Slavic feminine)
  [/ii$/, 'iy'], // -ii / -iy
  [/iy$/, 'y'], // -iy / -y
  [/ey$/, 'ei'], // -ey / -ei
  [/ei$/, 'ey'],
  [/yi$/, 'i'], // -yi / -i
  [/kh/, 'h'], // kh / h (Khalif / Halif)
  [/ts/, 'c'], // ts / c
  [/zh/, 'j'], // zh / j
  [/y(?=[aeiou])/g, 'i'], // yi/ya/ye → ii/ia/ie
];

/**
 * Country codes where appending the code as a handle suffix is conventional
 * (excludes NOR/USA which tend not to suffix). Lowercased to match handles.
 */
const COUNTRY_SUFFIX_OK = new Set([
  'rus',
  'ukr',
  'ind',
  'chn',
  'arm',
  'aze',
  'geo',
  'kaz',
  'uzb',
  'tur',
  'fra',
  'ger',
  'esp',
  'ita',
  'pol',
  'hun',
  'rou',
  'bul',
  'cze',
  'svk',
  'srb',
  'cro',
  'bra',
  'arg',
  'per',
  'mex',
  'iri',
  'isr',
  'vie',
  'phi',
  'ned',
  'bel',
  'swe',
  'fin',
  'den',
  'gre',
  'por',
]);

function transliterationAlts(token: string): string[] {
  if (token.length < 4) return [];
  const out = new Set<string>();
  for (const [pattern, replacement] of TRANSLIT_RULES) {
    const alt = token.replace(pattern, replacement);
    if (alt !== token && alt.length >= 3) out.add(alt);
  }
  return [...out];
}

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
  const countrySuffixOk = country !== null && COUNTRY_SUFFIX_OK.has(country);
  const birthYear = input.birth_year ?? null;
  const yyShort = birthYear !== null ? String(birthYear).slice(2) : null;
  const yyFull = birthYear !== null ? String(birthYear) : null;

  const nicknames: string[] = first && NICKNAMES[first] ? NICKNAMES[first]! : [];
  const lastTranslits = transliterationAlts(last);

  const out: Hypothesis[] = [];
  const seen = new Set<string>();
  const add = (handle: string, pattern: string) => {
    if (handle.length < 3 || handle.length > 25) return;
    if (seen.has(handle)) return;
    seen.add(handle);
    out.push({ handle, pattern });
  };

  // ---- Tier 1: strongest single/combined ---------------------------------
  add(last, 'last');
  if (first) add(first, 'first');

  if (first) {
    add(`${first}${last}`, 'firstlast');
    add(`${first}_${last}`, 'first_last');
    add(`${first}-${last}`, 'first-last');
  }

  // ---- Tier 2: nicknames (high signal when present) ----------------------
  for (const nick of nicknames) {
    add(`${nick}${last}`, 'nick+last');
    add(`${nick}_${last}`, 'nick_last');
  }

  // ---- Tier 3: reversed and initial forms --------------------------------
  if (first) {
    add(`${last}${first}`, 'lastfirst');
    add(`${last}_${first}`, 'last_first');
    add(`${last}-${first}`, 'last-first');
  }

  if (firstInitial) {
    add(`${firstInitial}${last}`, 'I+last');
    add(`${firstInitial}_${last}`, 'I_last');
    add(`${last}${firstInitial}`, 'last+I');
    add(`${last}_${firstInitial}`, 'last_I');
  }

  // ---- Tier 4: DOB variants ----------------------------------------------
  if (yyShort) {
    add(`${last}${yyShort}`, 'last+YY');
    add(`${last}_${yyShort}`, 'last_YY');
    if (first) {
      add(`${first}${yyShort}`, 'first+YY');
      add(`${first}_${yyShort}`, 'first_YY');
      add(`${first}${last}${yyShort}`, 'firstlast+YY');
      add(`${first}_${last}_${yyShort}`, 'first_last_YY');
    }
    for (const nick of nicknames) {
      add(`${nick}${yyShort}`, 'nick+YY');
      add(`${nick}_${yyShort}`, 'nick_YY');
    }
  }
  if (yyFull && yyFull !== yyShort) {
    add(`${last}${yyFull}`, 'last+YYYY');
    add(`${last}_${yyFull}`, 'last_YYYY');
  }

  // ---- Tier 5: federation-conventional suffixes --------------------------
  add(`${last}chess`, 'last+chess');
  add(`${last}_chess`, 'last_chess');
  if (first) {
    add(`${first}${last}chess`, 'firstlast+chess');
    add(`${first}_${last}_chess`, 'first_last_chess');
  }
  for (const nick of nicknames) {
    add(`${nick}chess`, 'nick+chess');
    add(`${nick}_chess`, 'nick_chess');
  }

  // ---- Tier 6: country variants ------------------------------------------
  if (country) {
    add(`${last}${country}`, 'last+country');
    add(`${last}_${country}`, 'last_country');
    if (first) {
      add(`${first}_${last}_${country}`, 'first_last_country');
      if (countrySuffixOk) {
        add(`${first}${last}${country}`, 'firstlast+country');
        add(`${first}_${country}`, 'first_country');
      }
    }
  }

  // ---- Tier 7: transliteration alternates --------------------------------
  for (const alt of lastTranslits) {
    add(alt, 'last~translit');
    if (first) {
      add(`${first}${alt}`, 'first+last~translit');
      add(`${first}_${alt}`, 'first_last~translit');
    }
  }

  return out;
}
