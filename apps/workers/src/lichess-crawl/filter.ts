/**
 * Inclusion predicate for Lichess crawler responses.
 *
 * Diverges from apps/workers/src/lichess-dumps/filter.ts in one place:
 * we DON'T check the Event header for a "Rated" marker. The user-export
 * endpoint is hit with `?rated=true` which filters server-side, and its
 * Event header conventions are inconsistent — regular games use
 * lowercase "rated bullet game", arenas use "Take Take Take Arena", etc.
 * The dump filter expects capital-R "Rated" which drops everything here.
 *
 * Otherwise identical: variant=Standard, both Elos ≥ 1500, has a result.
 */
import type { PgnHeaders } from '../lichess-dumps/types';

export const LICHESS_CRAWL_FILTER = {
  /** Both Elos must clear this. Set to 1400 on 2026-05-14 as the broad
   *  floor for the v1 tournament-prep audience. Top-down crawl order
   *  enforced by queue priority (T1=1900+, T2, T3) not by the floor.
   *  Matches lichess-dumps/config.ts FILTER.minElo. */
  minElo: 1400,
  variant: 'Standard',
} as const;

export interface CrawlFilterStats {
  seen: number;
  reasonVariant: number;
  reasonNoElo: number;
  reasonLowElo: number;
  reasonNoResult: number;
  accepted: number;
}

export function emptyCrawlFilterStats(): CrawlFilterStats {
  return {
    seen: 0,
    reasonVariant: 0,
    reasonNoElo: 0,
    reasonLowElo: 0,
    reasonNoResult: 0,
    accepted: 0,
  };
}

export function shouldIngestLichessCrawl(headers: PgnHeaders, stats: CrawlFilterStats): boolean {
  stats.seen++;

  // Lichess omits Variant for Standard in some payloads; treat missing as Standard.
  const variant = headers.Variant ?? 'Standard';
  if (variant !== LICHESS_CRAWL_FILTER.variant) {
    stats.reasonVariant++;
    return false;
  }

  const we = parseElo(headers.WhiteElo);
  const be = parseElo(headers.BlackElo);
  if (we === null || be === null) {
    stats.reasonNoElo++;
    return false;
  }
  if (we < LICHESS_CRAWL_FILTER.minElo || be < LICHESS_CRAWL_FILTER.minElo) {
    stats.reasonLowElo++;
    return false;
  }

  if (!headers.Result || headers.Result === '*') {
    stats.reasonNoResult++;
    return false;
  }

  stats.accepted++;
  return true;
}

function parseElo(s: string | undefined): number | null {
  if (!s) return null;
  if (s === '?' || s === '-') return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}
