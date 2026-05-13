/**
 * USCF top-list scraper using Playwright headless Chromium.
 *
 * Why Playwright: uschess.org sits behind Cloudflare managed challenge.
 * Every endpoint returns 403 with a JS challenge if hit via plain
 * `fetch` (verified 2026-05-12). A real headless browser solves the
 * challenge automatically.
 *
 * Stealth notes:
 * - We launch Chromium with a real-looking UA string, viewport, locale.
 * - We don't use `playwright-extra` + stealth plugin yet because the
 *   public top-list pages don't seem to need it. If Cloudflare escalates
 *   we add stealth.
 * - 5s delay between category page loads keeps us civil.
 *
 * Each category page renders a table of up to 100 players. We grab:
 *   rank, USCF ID, name, rating, state, title (if shown).
 *
 * The selectors below are written defensively because USCF changes its
 * DOM occasionally. If a category page returns zero rows the scraper
 * logs a warning and continues; the run summary surfaces the empty list
 * so a dev can update selectors.
 */
import type { Browser, Page } from 'playwright-core';
import { normalizeName } from '../fide/normalize.js';
import { ALL_CATEGORIES, NATIONWIDE_CATEGORIES, type UscfCategory } from './categories.js';

export type UscfRow = {
  uscfId: string;
  name: string;
  nameNormalized: string;
  state: string | null;
  /** Standard rating (regular rated games). Null for quick/blitz-only categories. */
  ratingStandard: number | null;
  ratingQuick: number | null;
  ratingBlitz: number | null;
  title: string | null;
  /** Which category surfaced this row — useful for debugging dedupe. */
  sourceCategory: string;
  raw: Record<string, unknown>;
};

export type ScrapeOptions = {
  maxCategories?: number;
  delayMs?: number;
  /** Limit to nationwide categories (skip per-state). Useful for fast smoke runs. */
  nationwideOnly?: boolean;
  log?: (msg: string) => void;
  /** Inject a Browser for tests; default launches chromium from playwright-core. */
  browser?: Browser;
};

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import('playwright-core');
  return chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
}

async function newPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  return ctx.newPage();
}

/**
 * Parse one category page. Returns rows or empty array if the page
 * structure didn't match.
 */
async function scrapeCategory(page: Page, cat: UscfCategory): Promise<UscfRow[]> {
  await page.goto(cat.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  // Cloudflare challenge resolves in <3s on a clean IP. If we're flagged
  // it can take longer; wait up to 15s for the player table to appear.
  try {
    await page.waitForSelector('table, [data-testid="top-players-table"]', { timeout: 15_000 });
  } catch {
    return [];
  }

  const rows = await page.evaluate(() => {
    type ParsedRow = {
      rank: string;
      uscfId: string;
      name: string;
      state: string | null;
      rating: string;
      title: string | null;
    };
    const out: ParsedRow[] = [];
    const trs = document.querySelectorAll('table tr');
    for (const tr of Array.from(trs)) {
      const tds = tr.querySelectorAll('td');
      if (tds.length < 3) continue;
      const cells = Array.from(tds).map((td) => td.textContent?.trim() ?? '');
      // USCF top-list tables typically have: rank | name (with USCF link) | rating | state | title?
      // We probe each cell for the USCF ID via the anchor href because cell
      // order changes across categories.
      let uscfId = '';
      const anchor = tr.querySelector('a[href*="msa.uschess.org"], a[href*="player"]');
      if (anchor) {
        const href = (anchor as HTMLAnchorElement).getAttribute('href') ?? '';
        const m = href.match(/(\d{8})|(\d{4,8})/);
        if (m) uscfId = m[0];
      }
      if (!uscfId) continue;

      const name = anchor?.textContent?.trim() ?? cells[1] ?? '';
      if (!name) continue;

      // Best-effort cell mapping. Persist all cells in `raw` so we don't
      // lose data when USCF changes column order.
      const ratingCell = cells.find((c) => /^\d{3,4}$/.test(c)) ?? '';
      const stateCell = cells.find((c) => /^[A-Z]{2}$/.test(c)) ?? null;
      const titleCell = cells.find((c) => /^(GM|IM|FM|CM|WGM|WIM|WFM|WCM|NM|LM)$/.test(c)) ?? null;

      out.push({
        rank: cells[0] ?? '',
        uscfId,
        name,
        state: stateCell,
        rating: ratingCell,
        title: titleCell,
      });
    }
    return out;
  });

  return rows.map((r) => {
    const rating = /^\d+$/.test(r.rating) ? parseInt(r.rating, 10) : null;
    return {
      uscfId: r.uscfId,
      name: r.name,
      nameNormalized: normalizeName(r.name),
      state: r.state ?? cat.state,
      ratingStandard: cat.ratingType === 'standard' ? rating : null,
      ratingQuick: cat.ratingType === 'quick' ? rating : null,
      ratingBlitz: cat.ratingType === 'blitz' ? rating : null,
      title: r.title,
      sourceCategory: cat.slug,
      raw: {
        rank: r.rank,
        rating: r.rating,
        category: cat.slug,
        category_label: cat.label,
      },
    };
  });
}

/**
 * Scrape every configured USCF category. Yields rows as they're parsed;
 * the caller dedupes by `uscfId` (a player may appear in Top Overall +
 * Top Senior + Top State).
 */
export async function* scrapeUscf(opts: ScrapeOptions = {}): AsyncGenerator<UscfRow, void, void> {
  const log = opts.log ?? (() => {});
  const delayMs = opts.delayMs ?? 5000;
  const categories = opts.nationwideOnly ? NATIONWIDE_CATEGORIES : ALL_CATEGORIES;
  const limit = opts.maxCategories ?? categories.length;

  const browser = opts.browser ?? (await launchBrowser());
  const ownsBrowser = !opts.browser;
  const page = await newPage(browser);

  try {
    for (let i = 0; i < Math.min(limit, categories.length); i++) {
      const cat = categories[i]!;
      log(`[uscf] (${i + 1}/${limit}) ${cat.slug} — ${cat.url}`);
      try {
        const rows = await scrapeCategory(page, cat);
        log(`[uscf]   ${rows.length} rows`);
        for (const row of rows) yield row;
      } catch (err) {
        log(`[uscf]   error: ${(err as Error).message}`);
      }
      if (i + 1 < limit && delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  } finally {
    await page.close().catch(() => {});
    if (ownsBrowser) await browser.close().catch(() => {});
  }
}
