/**
 * Inclusion predicate for chess.com archive games.
 *
 * Same intent as apps/workers/src/lichess-dumps/filter.ts:
 *   rated standard chess, both Elos >= minElo, has a result.
 * Different mechanics — chess.com gives us structured fields so we don't
 * need to parse PGN headers to filter.
 */
import type { ChesscomArchiveGame } from '../lib/chesscom-api';

export const CHESSCOM_FILTER = {
  /** Both white.rating and black.rating must clear this. Lowered from
   *  1500 → 1000 to capture all tournament-active players, not just
   *  the top tier (decision locked 2026-05-13, plan: comprehensive
   *  seed expansion). */
  minElo: 1000,
} as const;

export interface ChesscomFilterStats {
  seen: number;
  reasonNotRated: number;
  reasonVariant: number;
  reasonNoElo: number;
  reasonLowElo: number;
  reasonNoPgn: number;
  accepted: number;
}

export function emptyChesscomFilterStats(): ChesscomFilterStats {
  return {
    seen: 0,
    reasonNotRated: 0,
    reasonVariant: 0,
    reasonNoElo: 0,
    reasonLowElo: 0,
    reasonNoPgn: 0,
    accepted: 0,
  };
}

export function shouldIngestChesscom(
  game: ChesscomArchiveGame,
  stats: ChesscomFilterStats,
): boolean {
  stats.seen++;

  if (!game.rated) {
    stats.reasonNotRated++;
    return false;
  }
  if (game.rules !== 'chess') {
    stats.reasonVariant++;
    return false;
  }
  const we = game.white?.rating;
  const be = game.black?.rating;
  if (typeof we !== 'number' || typeof be !== 'number') {
    stats.reasonNoElo++;
    return false;
  }
  if (we < CHESSCOM_FILTER.minElo || be < CHESSCOM_FILTER.minElo) {
    stats.reasonLowElo++;
    return false;
  }
  if (!game.pgn || game.pgn.length === 0) {
    stats.reasonNoPgn++;
    return false;
  }

  stats.accepted++;
  return true;
}
