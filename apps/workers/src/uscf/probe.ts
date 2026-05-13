/**
 * One-off Playwright probe — verifies that:
 *   1. Cloudflare lets a real-browser request through
 *   2. The expected DOM (`<table>` of top players) is present
 *   3. Our row-parsing selectors pick up rows
 *
 * No DB writes. Run before trusting the full `uscf:ingest` worker.
 *
 *   pnpm --filter @chessco/workers tsx src/uscf/probe.ts
 *   pnpm --filter @chessco/workers tsx src/uscf/probe.ts --url https://new.uschess.org/top-players/100-women
 */
import 'dotenv/config';
import { NATIONWIDE_CATEGORIES } from './categories.js';

async function main() {
  const args = process.argv.slice(2);
  const urlArg = args.indexOf('--url');
  const targetUrl = urlArg >= 0 ? args[urlArg + 1] : NATIONWIDE_CATEGORIES[0]!.url;
  if (!targetUrl) throw new Error('no URL');
  const dumpHtml = args.includes('--dump');

  const useStealth = !args.includes('--no-stealth');
  const useRealChrome = !args.includes('--chromium');
  console.log(
    `[probe] launching ${useRealChrome ? 'real Chrome (channel)' : 'bundled Chromium'}` +
      `${useStealth ? ' with stealth plugin' : ''}…`,
  );
  // playwright-extra wraps chromium so we can register stealth.
  const { chromium: rawChromium } = await import('playwright');
  let chromium = rawChromium as unknown as { launch: typeof rawChromium.launch };
  if (useStealth) {
    const { chromium: extraChromium } = await import('playwright-extra');
    const stealth = (await import('puppeteer-extra-plugin-stealth')).default();
    extraChromium.use(stealth);
    chromium = extraChromium as unknown as { launch: typeof rawChromium.launch };
  }
  const browser = await chromium.launch({
    headless: !args.includes('--headed'),
    ...(useRealChrome ? { channel: 'chrome' } : {}),
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });
  const page = await ctx.newPage();
  // Mask the most obvious automation tell. Cloudflare checks `navigator.webdriver`
  // (Playwright sets it to true by default).
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  try {
    console.log(`[probe] navigating ${targetUrl}…`);
    const res = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    console.log(`[probe] HTTP ${res?.status()}`);

    // Wait for any Cloudflare challenge to clear and JS-rendered tables to appear.
    // Cloudflare's managed challenge typically resolves itself in 5-8s when
    // the fingerprint passes.
    await page.waitForTimeout(8000);
    try {
      await page.waitForSelector('table, [data-testid="top-players-table"]', { timeout: 20_000 });
      console.log(`[probe] found a <table> — good sign`);
    } catch {
      console.log(`[probe] no <table> after 20s wait — Cloudflare may still be in the way`);
    }

    const html = await page.content();
    console.log(`[probe] page HTML length: ${html.length} chars`);
    if (dumpHtml) {
      console.log('--- HTML START ---');
      console.log(html);
      console.log('--- HTML END ---');
    }

    // Look for tell-tale player anchors.
    const anchorCount = await page
      .locator('a[href*="msa.uschess.org"], a[href*="/player"], a[href*="/players/"]')
      .count();
    console.log(`[probe] candidate player anchors: ${anchorCount}`);

    const tableCount = await page.locator('table').count();
    console.log(`[probe] tables on page: ${tableCount}`);

    if (tableCount > 0) {
      const firstTableRows = await page.locator('table tr').count();
      console.log(`[probe] rows in first table: ${firstTableRows}`);

      // First 3 row contents
      const sampleRows = await page.locator('table tr').evaluateAll((trs) =>
        trs.slice(0, 5).map((tr) => {
          const cells = Array.from(tr.querySelectorAll('td, th')).map((td) =>
            (td.textContent ?? '').trim(),
          );
          return cells;
        }),
      );
      console.log(`[probe] first 5 rows:`);
      for (const row of sampleRows) console.log(`  - ${JSON.stringify(row)}`);
    }

    // Detect a Cloudflare challenge banner.
    const cfText = await page
      .locator('text=/cloudflare|just a moment|checking your browser/i')
      .count();
    if (cfText > 0) {
      console.log(`[probe] CLOUDFLARE CHALLENGE detected — will need stealth or longer wait`);
    }

    // Final URL (in case we got redirected).
    console.log(`[probe] final URL: ${page.url()}`);
  } finally {
    await page.close();
    await ctx.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error('probe failed:', err);
  process.exit(1);
});
