/**
 * Helper for "cluster D/F" federations: SPA-rendered or Cloudflare-walled
 * rating pages that need a real browser. Promoted from `apps/workers/src/uscf/scrape.ts`.
 *
 * Cluster D (SPA, no bot wall): KNSB, TCF, others with client-rendered tables.
 * Cluster F (Cloudflare): USCF (parked) + any others tightening behind CF.
 *
 * Wire a federation:
 *
 *     yield* scrapeTablePages({
 *       url: 'https://example.org/ratings',
 *       waitForSelector: 'table.players tbody tr',
 *       rowSelector: 'table.players tbody tr',
 *       parseRow: (cells) => { … },
 *       pages: [1, 2, 3, …],
 *       pageUrlBuilder: (n) => `https://example.org/ratings?page=${n}`,
 *     });
 *
 * Cloud Run job dispatch is unchanged — see `apps/workers/src/inngest/cloud-run-jobs.ts`.
 * Browser launch options enable stealth-ish args by default. Add the actual
 * `playwright-extra` stealth plugin if a federation escalates.
 */
import type { Browser, BrowserContext, Page } from 'playwright-core';

import type { NormalizedFederationPlayerRow } from './upsert-federation-players.js';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface LaunchBrowserOptions {
  headless?: boolean;
  /** Extra Chromium launch args (Cloudflare-walled feds may need more). */
  extraArgs?: string[];
  /** Inject for tests. */
  browser?: Browser;
}

export async function launchScrapeBrowser(opts: LaunchBrowserOptions = {}): Promise<Browser> {
  if (opts.browser) return opts.browser;
  const { chromium } = await import('playwright-core');
  return chromium.launch({
    headless: opts.headless ?? true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      ...(opts.extraArgs ?? []),
    ],
  });
}

export interface NewScrapeContextOptions {
  userAgent?: string;
  locale?: string;
  timezoneId?: string;
  viewport?: { width: number; height: number };
}

export async function newScrapeContext(
  browser: Browser,
  opts: NewScrapeContextOptions = {},
): Promise<BrowserContext> {
  return browser.newContext({
    userAgent: opts.userAgent ?? DEFAULT_USER_AGENT,
    viewport: opts.viewport ?? { width: 1280, height: 800 },
    locale: opts.locale ?? 'en-US',
    timezoneId: opts.timezoneId ?? 'UTC',
  });
}

export interface ScrapeTablePagesOptions {
  /** Page-number array (1, 2, 3, …) or URL list. */
  pages: number[];
  pageUrlBuilder: (page: number) => string;
  /** CSS selector to wait for before parsing. */
  waitForSelector: string;
  /** Selector for one row. Parser receives `td` cell text content. */
  rowSelector: string;
  parseRow: (cellText: string[], pageNum: number) => NormalizedFederationPlayerRow | null;
  /** Optional pre-page hook (e.g. click "load more"). */
  preParse?: (page: Page, pageNum: number) => Promise<void>;
  delayMs?: number;
  log?: (msg: string) => void;
  signal?: AbortSignal;
  /** Inject browser for tests; otherwise we launch our own. */
  browser?: Browser;
  /** Timeout per page (ms). Defaults to 30s. */
  pageTimeoutMs?: number;
  /** Pass through to `launchScrapeBrowser`. */
  launchOpts?: Omit<LaunchBrowserOptions, 'browser'>;
  /** Pass through to `newScrapeContext`. */
  contextOpts?: NewScrapeContextOptions;
}

export async function* scrapeTablePages(
  opts: ScrapeTablePagesOptions,
): AsyncGenerator<NormalizedFederationPlayerRow, void, void> {
  const log = opts.log ?? (() => {});
  const delayMs = opts.delayMs ?? 2000;
  const pageTimeoutMs = opts.pageTimeoutMs ?? 30_000;

  const browser = await launchScrapeBrowser({ ...opts.launchOpts, browser: opts.browser });
  let ownsBrowser = !opts.browser;
  const context = await newScrapeContext(browser, opts.contextOpts);

  try {
    for (const pageNum of opts.pages) {
      if (opts.signal?.aborted) return;
      const url = opts.pageUrlBuilder(pageNum);
      const page = await context.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: pageTimeoutMs });
        if (opts.preParse) await opts.preParse(page, pageNum);
        await page.waitForSelector(opts.waitForSelector, { timeout: pageTimeoutMs });

        const rows = await page.$$eval(opts.rowSelector, (els) =>
          els.map((row) =>
            Array.from(row.querySelectorAll('td')).map((c) => (c.textContent ?? '').trim()),
          ),
        );

        let yielded = 0;
        for (const cells of rows) {
          const parsed = opts.parseRow(cells, pageNum);
          if (parsed) {
            yielded++;
            yield parsed;
          }
        }
        log(`[playwright] page ${pageNum}: ${yielded} rows`);
      } catch (err) {
        log(`[playwright] page ${pageNum} error: ${(err as Error).message}; continuing`);
      } finally {
        await page.close().catch(() => {});
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  } finally {
    await context.close().catch(() => {});
    if (ownsBrowser) await browser.close().catch(() => {});
  }
}
