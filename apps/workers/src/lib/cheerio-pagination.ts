/**
 * Helper for "cluster B" federations: server-rendered HTML rating lists
 * paginated by URL (`?page=N`) or query-string, no bot wall.
 *
 * Most fetch-only federations in the long tail (DSB, FFE for some endpoints,
 * NOR, SWE, FIN, etc.) fit this pattern. Wire a federation in ~30 lines:
 *
 *     async function* fetchEcfPlayers(ctx): AsyncGenerator<NormalizedFederationPlayerRow> {
 *       yield* paginateHtml({
 *         url: (page) => `https://www.englishchess.org.uk/ratings?page=${page}`,
 *         rowSelector: 'table.rating-list > tbody > tr',
 *         parseRow: ($row) => {
 *           const id = $row.find('td.id').text().trim();
 *           const name = $row.find('td.name').text().trim();
 *           if (!id || !name) return null;
 *           return {
 *             federationPlayerId: id,
 *             name,
 *             nameNormalized: normalizeName(name),
 *             country: 'GB',
 *             ratingStandard: parseInt($row.find('td.std').text(), 10) || null,
 *             // …
 *             raw: { …$row.toString() },
 *           };
 *         },
 *         maxPages: 200,
 *         log: ctx.log,
 *       });
 *     }
 */
import * as cheerio from 'cheerio';

import type { NormalizedFederationPlayerRow } from './upsert-federation-players.js';

// cheerio 1.x no longer exports an `Element` type at the package root; the
// element type comes from `domhandler` which we don't depend on directly.
// Use a structural alias instead — Cheerio<any> is interoperable.
type CheerioRow = cheerio.Cheerio<any>;

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface PaginateHtmlOptions {
  /** URL builder for page N (1-indexed). */
  url: (page: number) => string;
  /** Optional extra headers (User-Agent defaults to a recent Chrome). */
  headers?: Record<string, string>;
  /** Cheerio selector for one table row. */
  rowSelector: string;
  /** Parser: return null to skip a row. */
  parseRow: ($row: CheerioRow, $: cheerio.CheerioAPI) => NormalizedFederationPlayerRow | null;
  /** Soft cap to avoid runaway loops. */
  maxPages?: number;
  /** Politeness delay between requests. */
  delayMs?: number;
  /** Logger; defaults to no-op. */
  log?: (msg: string) => void;
  /** Abort signal (timeout / cancellation). */
  signal?: AbortSignal;
}

export async function* paginateHtml(
  opts: PaginateHtmlOptions,
): AsyncGenerator<NormalizedFederationPlayerRow, void, void> {
  const log = opts.log ?? (() => {});
  const delayMs = opts.delayMs ?? 500;
  const maxPages = opts.maxPages ?? 500;
  const headers: Record<string, string> = {
    'User-Agent': DEFAULT_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml',
    ...(opts.headers ?? {}),
  };

  let consecutiveEmpty = 0;
  for (let page = 1; page <= maxPages; page++) {
    if (opts.signal?.aborted) return;
    if (page > 1 && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }

    const url = opts.url(page);
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: opts.signal });
    } catch (err) {
      log(`[paginateHtml] page ${page} fetch error: ${(err as Error).message}`);
      return;
    }
    if (!res.ok) {
      log(`[paginateHtml] page ${page}: HTTP ${res.status} — bailing`);
      return;
    }

    const html = await res.text();
    const $ = cheerio.load(html);
    let pageCount = 0;
    $(opts.rowSelector).each((_, el) => {
      const $row = $(el);
      const parsed = opts.parseRow($row, $);
      if (parsed) pageCount++;
    });

    if (pageCount === 0) {
      consecutiveEmpty++;
      log(`[paginateHtml] page ${page}: 0 rows (consecutive empty = ${consecutiveEmpty})`);
      if (consecutiveEmpty >= 2) return;
      continue;
    }
    consecutiveEmpty = 0;

    if (page === 1 || page % 10 === 0) {
      log(`[paginateHtml] page ${page}: ${pageCount} rows`);
    }

    // Re-iterate to yield rows (we counted above for the bail-out check)
    const yielded: NormalizedFederationPlayerRow[] = [];
    $(opts.rowSelector).each((_, el) => {
      const $row = $(el);
      const parsed = opts.parseRow($row, $);
      if (parsed) yielded.push(parsed);
    });
    for (const row of yielded) yield row;
  }
}
