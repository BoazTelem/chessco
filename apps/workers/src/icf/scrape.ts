/**
 * Israeli Chess Federation ratings scraper.
 *
 * The site (`chess.org.il`) is an ASP.NET WebForms app. The rankings page
 * (`/Players/PlayersRanking.aspx`) shows 100 players per page in an
 * ASP.NET GridView. Pagination is `__doPostBack` form posts that require
 * the page's `__VIEWSTATE`, `__VIEWSTATEGENERATOR`, and `__EVENTVALIDATION`
 * tokens. We harvest those on each page and POST back with the next-page
 * event.
 */
import * as cheerio from 'cheerio';
import { normalizeName } from '../fide/normalize.js';

export const ICF_RANKINGS_URL = 'https://www.chess.org.il/Players/PlayersRanking.aspx';
const GRIDVIEW_NAME = 'ctl00$ContentPlaceHolder1$playersGreidview';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export type IcfRow = {
  icfId: string;
  rank: number | null;
  name: string;
  nameNormalized: string;
  israeliRating: number | null;
  fideRating: number | null;
  raw: { rank?: number; israeli_rating?: number; fide_rating?: number };
};

type ViewState = {
  __VIEWSTATE: string;
  __VIEWSTATEGENERATOR: string;
  __EVENTVALIDATION: string;
};

function extractViewState($: cheerio.CheerioAPI): ViewState {
  return {
    __VIEWSTATE: String($('input[name="__VIEWSTATE"]').val() ?? ''),
    __VIEWSTATEGENERATOR: String($('input[name="__VIEWSTATEGENERATOR"]').val() ?? ''),
    __EVENTVALIDATION: String($('input[name="__EVENTVALIDATION"]').val() ?? ''),
  };
}

/**
 * Parse rows from a rankings page. Each row has 5 cells: rank, ICF ID, name
 * (anchor), Israeli rating, FIDE rating.
 */
function parseRows($: cheerio.CheerioAPI): IcfRow[] {
  const rows: IcfRow[] = [];

  $(`#ctl00_ContentPlaceHolder1_playersGreidview tr`).each((_, tr) => {
    const $tr = $(tr);
    const cells = $tr.find('td');
    if (cells.length < 5) return; // header or pager row

    const rankText = $(cells[0]).text().trim();
    const idText = $(cells[1]).text().trim();
    const $anchor = $(cells[2]).find('a[href*="Player.aspx?Id="]');
    const name = $anchor.text().trim();
    const href = $anchor.attr('href') ?? '';
    const israeliText = $(cells[3]).text().trim();
    const fideText = $(cells[4]).text().trim();

    // Prefer the ID from the anchor href (more authoritative than the cell text)
    const idMatch = href.match(/Id=(\d+)/);
    const icfId = idMatch?.[1] ?? idText;
    if (!icfId || !/^\d+$/.test(icfId) || !name) return;

    const rank = /^\d+$/.test(rankText) ? parseInt(rankText, 10) : null;
    const israeliRating = /^\d+$/.test(israeliText) ? parseInt(israeliText, 10) : null;
    const fideRating = /^\d+$/.test(fideText) ? parseInt(fideText, 10) : null;

    rows.push({
      icfId,
      rank,
      name,
      nameNormalized: normalizeName(name),
      israeliRating,
      fideRating,
      raw: {
        rank: rank ?? undefined,
        israeli_rating: israeliRating ?? undefined,
        fide_rating: fideRating ?? undefined,
      },
    });
  });

  return rows;
}

async function fetchInitialPage(): Promise<{
  html: string;
  rows: IcfRow[];
  viewState: ViewState;
}> {
  const res = await fetch(ICF_RANKINGS_URL, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) {
    throw new Error(`ICF initial fetch failed: HTTP ${res.status}`);
  }
  const html = await res.text();
  const $ = cheerio.load(html);
  return { html, rows: parseRows($), viewState: extractViewState($) };
}

async function fetchPage(
  pageNumber: number,
  viewState: ViewState,
): Promise<{ rows: IcfRow[]; viewState: ViewState }> {
  const formData = new URLSearchParams({
    __EVENTTARGET: GRIDVIEW_NAME,
    __EVENTARGUMENT: `Page$${pageNumber}`,
    __VIEWSTATE: viewState.__VIEWSTATE,
    __VIEWSTATEGENERATOR: viewState.__VIEWSTATEGENERATOR,
    __EVENTVALIDATION: viewState.__EVENTVALIDATION,
    __LASTFOCUS: '',
  });

  const res = await fetch(ICF_RANKINGS_URL, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html,application/xhtml+xml',
      Referer: ICF_RANKINGS_URL,
    },
    body: formData.toString(),
  });
  if (!res.ok) {
    throw new Error(`ICF page ${pageNumber} fetch failed: HTTP ${res.status}`);
  }
  const html = await res.text();
  const $ = cheerio.load(html);
  return { rows: parseRows($), viewState: extractViewState($) };
}

export type ScrapeOptions = {
  maxPages?: number;
  delayMs?: number;
  log?: (msg: string) => void;
};

/**
 * Scrape all pages of the ICF rankings GridView. Yields rows as they're
 * parsed; the caller decides when to flush to the DB.
 */
export async function* scrapeAllPages(
  opts: ScrapeOptions = {},
): AsyncGenerator<IcfRow, void, void> {
  const log = opts.log ?? (() => {});
  const delayMs = opts.delayMs ?? 1000;
  const maxPages = opts.maxPages ?? 1000;

  log(`[icf] fetching page 1…`);
  const { rows: page1Rows, viewState: initialState } = await fetchInitialPage();
  log(`[icf] page 1: ${page1Rows.length} rows`);
  for (const row of page1Rows) yield row;

  if (page1Rows.length === 0) {
    log(`[icf] page 1 empty — bailing out`);
    return;
  }

  let viewState = initialState;
  let consecutiveEmpty = 0;

  for (let page = 2; page <= maxPages; page++) {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

    let result: { rows: IcfRow[]; viewState: ViewState };
    try {
      result = await fetchPage(page, viewState);
    } catch (err) {
      log(`[icf] page ${page} error: ${(err as Error).message}; bailing`);
      return;
    }

    if (result.rows.length === 0) {
      consecutiveEmpty++;
      log(`[icf] page ${page}: 0 rows (consecutive empty = ${consecutiveEmpty})`);
      if (consecutiveEmpty >= 2) {
        log(`[icf] reached end of rankings`);
        return;
      }
      continue;
    }
    consecutiveEmpty = 0;
    viewState = result.viewState;

    if (page % 10 === 0) {
      log(`[icf] page ${page}: ${result.rows.length} rows`);
    }
    for (const row of result.rows) yield row;
  }
}
