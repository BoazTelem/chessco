/**
 * Parse a PGN into a flat list of moves with the FEN before/after each ply.
 * Used by the live game's moves sidebar and the post-game review board so
 * both views show the same move list and notation.
 */

import { Chess } from 'chess.js';

export interface ParsedMove {
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
}

export function parsePgnToMoves(pgn: string, initialFen: string): ParsedMove[] {
  if (!pgn?.trim()) return [];
  const chess = new Chess(initialFen);
  try {
    chess.loadPgn(pgn);
  } catch {
    return [];
  }
  const history = chess.history({ verbose: true });
  const replay = new Chess(initialFen);
  const out: ParsedMove[] = [];
  for (const h of history) {
    const fenBefore = replay.fen();
    const m = replay.move({ from: h.from, to: h.to, promotion: h.promotion });
    if (!m) break;
    out.push({
      san: h.san,
      uci: `${h.from}${h.to}${h.promotion ?? ''}`,
      fenBefore,
      fenAfter: replay.fen(),
    });
  }
  return out;
}
