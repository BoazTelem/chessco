/**
 * Helper for "cluster C" federations: ASP.NET WebForms apps that paginate
 * GridView via `__VIEWSTATE` / `__EVENTVALIDATION` postbacks. Promoted from
 * `apps/workers/src/icf/scrape.ts` (ICF was the first one we shipped).
 *
 * Federations matching this pattern: ICF (done), FFE, FEDA, some others
 * across Eastern Europe and Latin America. The protocol is:
 *
 *   1. GET the rankings page, parse __VIEWSTATE / __VIEWSTATEGENERATOR /
 *      __EVENTVALIDATION + page-1 rows.
 *   2. For page N: POST back with `__EVENTTARGET=<gridviewName>` +
 *      `__EVENTARGUMENT=Page$N` + the harvested ViewState fields. Server
 *      returns the next page (rows + fresh ViewState). Repeat.
 *
 * Wire a federation in ~40 lines:
 *
 *     yield* paginateAspnet({
 *       url: 'https://www.example.org/Players.aspx',
 *       gridviewName: 'ctl00$ContentPlaceHolder1$playersGrid',
 *       rowSelector: '#ctl00_ContentPlaceHolder1_playersGrid > tbody > tr',
 *       parseRow: ($row, $) => { … },
 *     });
 */
import * as cheerio from 'cheerio';

import type { NormalizedFederationPlayerRow } from './upsert-federation-players.js';

// cheerio 1.x no longer exports an `Element` type at the package root. See
// `cheerio-pagination.ts` for the same alias.
type CheerioRow = cheerio.Cheerio<any>;

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface ViewState {
  __VIEWSTATE: string;
  __VIEWSTATEGENERATOR: string;
  __EVENTVALIDATION: string;
}

function harvestViewState($: cheerio.CheerioAPI): ViewState {
  return {
    __VIEWSTATE: String($('input[name="__VIEWSTATE"]').val() ?? ''),
    __VIEWSTATEGENERATOR: String($('input[name="__VIEWSTATEGENERATOR"]').val() ?? ''),
    __EVENTVALIDATION: String($('input[name="__EVENTVALIDATION"]').val() ?? ''),
  };
}

export interface PaginateAspnetOptions {
  url: string;
  /** Server-side ASP.NET name of the GridView, e.g. 'ctl00$ContentPlaceHolder1$myGrid'. */
  gridviewName: string;
  /** Cheerio selector for one row inside the GridView. */
  rowSelector: string;
  parseRow: ($row: CheerioRow, $: cheerio.CheerioAPI) => NormalizedFederationPlayerRow | null;
  /** Optional extra headers (User-Agent defaults to a recent Chrome). */
  headers?: Record<string, string>;
  maxPages?: number;
  delayMs?: number;
  log?: (msg: string) => void;
  signal?: AbortSignal;
}

export async function* paginateAspnet(
  opts: PaginateAspnetOptions,
): AsyncGenerator<NormalizedFederationPlayerRow, void, void> {
  const log = opts.log ?? (() => {});
  const delayMs = opts.delayMs ?? 1000;
  const maxPages = opts.maxPages ?? 1000;
  const baseHeaders: Record<string, string> = {
    'User-Agent': DEFAULT_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml',
    ...(opts.headers ?? {}),
  };

  log(`[aspnet] page 1: GET ${opts.url}`);
  const initial = await fetch(opts.url, { headers: baseHeaders, signal: opts.signal });
  if (!initial.ok) {
    log(`[aspnet] initial GET failed: HTTP ${initial.status}`);
    return;
  }
  let $ = cheerio.load(await initial.text());
  let viewState = harvestViewState($);

  function* yieldRows(
    $page: cheerio.CheerioAPI,
  ): Generator<NormalizedFederationPlayerRow, number, void> {
    let count = 0;
    const rows: NormalizedFederationPlayerRow[] = [];
    $page(opts.rowSelector).each((_, el) => {
      const parsed = opts.parseRow($page(el), $page);
      if (parsed) {
        rows.push(parsed);
        count++;
      }
    });
    for (const r of rows) yield r;
    return count;
  }

  let initialCount = 0;
  for (const r of yieldRows($)) {
    initialCount++;
    yield r;
  }
  log(`[aspnet] page 1: ${initialCount} rows`);
  if (initialCount === 0) return;

  let consecutiveEmpty = 0;
  for (let page = 2; page <= maxPages; page++) {
    if (opts.signal?.aborted) return;
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

    const formData = new URLSearchParams({
      __EVENTTARGET: opts.gridviewName,
      __EVENTARGUMENT: `Page$${page}`,
      __VIEWSTATE: viewState.__VIEWSTATE,
      __VIEWSTATEGENERATOR: viewState.__VIEWSTATEGENERATOR,
      __EVENTVALIDATION: viewState.__EVENTVALIDATION,
      __LASTFOCUS: '',
    });

    let res: Response;
    try {
      res = await fetch(opts.url, {
        method: 'POST',
        headers: {
          ...baseHeaders,
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: opts.url,
        },
        body: formData.toString(),
        signal: opts.signal,
      });
    } catch (err) {
      log(`[aspnet] page ${page} fetch error: ${(err as Error).message}; bailing`);
      return;
    }

    if (!res.ok) {
      log(`[aspnet] page ${page}: HTTP ${res.status} — bailing`);
      return;
    }

    $ = cheerio.load(await res.text());
    viewState = harvestViewState($);

    let pageCount = 0;
    for (const r of yieldRows($)) {
      pageCount++;
      yield r;
    }

    if (pageCount === 0) {
      consecutiveEmpty++;
      log(`[aspnet] page ${page}: 0 rows (consecutive empty = ${consecutiveEmpty})`);
      if (consecutiveEmpty >= 2) return;
      continue;
    }
    consecutiveEmpty = 0;
    if (page % 10 === 0) log(`[aspnet] page ${page}: ${pageCount} rows`);
  }
}
