/**
 * Inclusion predicate for the Lichess monthly dump.
 * Spec §5/PLAN.md Phase 1 W1: rated standard, both Elos >= minElo.
 */
import { FILTER } from './config';
import type { PgnHeaders } from './types';

export interface FilterStats {
  seen: number;
  reasonNotRated: number;
  reasonVariant: number;
  reasonNoElo: number;
  reasonLowElo: number;
  reasonNoResult: number;
  accepted: number;
}

export function emptyFilterStats(): FilterStats {
  return {
    seen: 0,
    reasonNotRated: 0,
    reasonVariant: 0,
    reasonNoElo: 0,
    reasonLowElo: 0,
    reasonNoResult: 0,
    accepted: 0,
  };
}

export function shouldIngest(headers: PgnHeaders, stats: FilterStats): boolean {
  stats.seen++;

  const event = headers.Event ?? '';
  if (!FILTER.ratedEventMarkers.some((m) => event.includes(m))) {
    stats.reasonNotRated++;
    return false;
  }

  // Lichess omits Variant for Standard in some dumps; treat missing as Standard.
  const variant = headers.Variant ?? 'Standard';
  if (variant !== FILTER.variant) {
    stats.reasonVariant++;
    return false;
  }

  const we = parseElo(headers.WhiteElo);
  const be = parseElo(headers.BlackElo);
  if (we === null || be === null) {
    stats.reasonNoElo++;
    return false;
  }
  if (we < FILTER.minElo || be < FILTER.minElo) {
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
