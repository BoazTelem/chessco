/**
 * USCF top-list categories to scrape.
 *
 * USCF doesn't publish a public full-directory dump — the full member list
 * is gated behind paid USCF membership. The public top-100 pages are the
 * legal scrape target.
 *
 * Each category yields up to 100 USCF IDs + names + ratings. After dedupe
 * across categories we expect ~10–25k unique USCF IDs.
 *
 * URLs target the new USCF site (`new.uschess.org/top-players`). If a URL
 * 404s the worker logs and skips — the list lives in code precisely so a
 * dev can correct a renamed category quickly and re-run.
 *
 * **Anti-bot status (2026-05-13):** every URL below sits behind Cloudflare
 * managed challenge. Plain HTTP fetch returns 403; Playwright headless
 * Chromium with a real-browser fingerprint passes.
 */

export type UscfCategory = {
  slug: string;
  label: string;
  url: string;
  ratingType: 'standard' | 'quick' | 'blitz';
  /** ISO 3166-2:US code for per-state lists; null for nationwide. */
  state: string | null;
};

const BASE = 'https://new.uschess.org/top-players';

export const NATIONWIDE_CATEGORIES: UscfCategory[] = [
  {
    slug: 'overall-active',
    label: 'Top 100 Active Overall',
    url: `${BASE}/100-active-overall`,
    ratingType: 'standard',
    state: null,
  },
  {
    slug: 'overall-overall',
    label: 'Top 100 Overall (all members)',
    url: `${BASE}/100-overall`,
    ratingType: 'standard',
    state: null,
  },
  {
    slug: 'women',
    label: 'Top 100 Women',
    url: `${BASE}/100-women`,
    ratingType: 'standard',
    state: null,
  },
  {
    slug: 'senior-50',
    label: 'Top 100 Senior (50+)',
    url: `${BASE}/100-senior`,
    ratingType: 'standard',
    state: null,
  },
  {
    slug: 'junior-21',
    label: 'Top 100 Junior (under 21)',
    url: `${BASE}/100-junior`,
    ratingType: 'standard',
    state: null,
  },
  {
    slug: 'age-13',
    label: 'Top 100 Age 13 & under',
    url: `${BASE}/100-age-13`,
    ratingType: 'standard',
    state: null,
  },
  {
    slug: 'quick',
    label: 'Top 100 Quick',
    url: `${BASE}/100-quick`,
    ratingType: 'quick',
    state: null,
  },
  {
    slug: 'blitz',
    label: 'Top 100 Blitz',
    url: `${BASE}/100-blitz`,
    ratingType: 'blitz',
    state: null,
  },
];

const US_STATES = [
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
];

export const STATE_CATEGORIES: UscfCategory[] = US_STATES.map((s) => ({
  slug: `state-${s.toLowerCase()}`,
  label: `Top 100 — ${s}`,
  url: `${BASE}/state/${s.toLowerCase()}`,
  ratingType: 'standard' as const,
  state: s,
}));

export const ALL_CATEGORIES: UscfCategory[] = [...NATIONWIDE_CATEGORIES, ...STATE_CATEGORIES];
