/**
 * Per-player enrichment scraper for ICF.
 *
 * The rankings list (`PlayersRanking.aspx`) only gives us name + ICF ID +
 * standard rating + FIDE rating. The per-player profile page
 * (`Player.aspx?Id=<icf_id>`) carries:
 *
 *   - English transliteration ("בוריס גלפנד" → "Boris Gelfand")
 *   - Israeli rapid + blitz ratings
 *   - Title (IM, GM, etc.) — sometimes blank
 *   - Birth year (sometimes)
 *
 * The page is plain ASP.NET HTML; no Cloudflare. Polite at 1 req/s.
 *
 * Selectors below probe defensively because chess.org.il rearranges its
 * profile labels occasionally. Anything we fail to parse we leave NULL,
 * and the next enrichment run picks it up.
 */
import * as cheerio from 'cheerio';

export const ICF_PLAYER_BASE = 'https://www.chess.org.il/Players/Player.aspx?Id=';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export type IcfEnrichment = {
  icfId: string;
  /** English transliteration. Null when only Hebrew is on the page. */
  nameEnglish: string | null;
  title: string | null;
  ratingRapid: number | null;
  ratingBlitz: number | null;
  birthYear: number | null;
  raw: Record<string, unknown>;
};

const TITLE_PATTERN = /^(GM|IM|FM|CM|WGM|WIM|WFM|WCM|NM|AGM|AIM|AFM|ACM)$/i;

function intOrNull(value: string | undefined | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return parseInt(trimmed, 10);
}

/**
 * Parse a single Player.aspx HTML page. Extracts whatever fields are
 * recognizable; missing fields come back as null.
 */
export function parseIcfPlayerPage(icfId: string, html: string): IcfEnrichment {
  const $ = cheerio.load(html);
  const raw: Record<string, unknown> = {};

  // Strategy: walk every label/value pair in the profile. The page renders
  // each as `<td>label</td><td>value</td>` or `<span class="label">…</span>`.
  // We grab everything into a label→value dict, then map known labels.
  const pairs: Record<string, string> = {};
  $('table tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length >= 2) {
      const k = $(tds[0])
        .text()
        .trim()
        .replace(/[:：]$/, '');
      const v = $(tds[1]).text().trim();
      if (k && v) pairs[k] = v;
    }
  });
  raw.pairs = pairs;

  // English name candidates — chess.org.il labels both "English Name" and
  // sometimes "Latin Name" depending on era.
  const englishLabel = Object.keys(pairs).find((k) =>
    /english|latin|name.*\(en\)|name.*english/i.test(k),
  );
  const nameEnglish = englishLabel ? pairs[englishLabel]?.trim() || null : null;

  // Title — discrete set, scan all values for a single-word match.
  let title: string | null = null;
  for (const v of Object.values(pairs)) {
    const trimmed = v.trim();
    if (TITLE_PATTERN.test(trimmed)) {
      title = trimmed.toUpperCase();
      break;
    }
  }

  // Rapid / blitz / birth year — best-effort label match.
  const rapidLabel = Object.keys(pairs).find((k) => /rapid|מהיר/i.test(k));
  const blitzLabel = Object.keys(pairs).find((k) => /blitz|בזק/i.test(k));
  const birthLabel = Object.keys(pairs).find((k) => /birth|נולד|year of birth/i.test(k));

  const ratingRapid = rapidLabel ? intOrNull(pairs[rapidLabel]) : null;
  const ratingBlitz = blitzLabel ? intOrNull(pairs[blitzLabel]) : null;
  const birthRaw = birthLabel ? pairs[birthLabel] : null;
  let birthYear: number | null = null;
  if (birthRaw) {
    const m = birthRaw.match(/(19|20)\d{2}/);
    if (m) birthYear = parseInt(m[0], 10);
  }

  return {
    icfId,
    nameEnglish,
    title,
    ratingRapid,
    ratingBlitz,
    birthYear,
    raw,
  };
}

export async function fetchIcfPlayer(icfId: string): Promise<IcfEnrichment | null> {
  const url = `${ICF_PLAYER_BASE}${encodeURIComponent(icfId)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
  });
  if (!res.ok) return null;
  const html = await res.text();
  return parseIcfPlayerPage(icfId, html);
}
