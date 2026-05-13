import { Chess } from 'chess.js';

/**
 * Validate a FEN string for use as a Practice starting position.
 *
 * chess.js's own constructor accepts most legal FENs but is permissive about
 * impossible-but-syntactically-valid positions (e.g. white in check on Black's
 * move). We layer extra sanity on top: both kings present, mover not currently
 * delivering check, no side has more than 16 pieces, reasonable pawn counts.
 */

export interface FenValidationOk {
  ok: true;
  fen: string; // normalized (re-emitted by chess.js)
  sideToMove: 'w' | 'b';
}
export interface FenValidationErr {
  ok: false;
  reason: string;
}
export type FenValidation = FenValidationOk | FenValidationErr;

const STANDARD_START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export function validateFen(input: string): FenValidation {
  const raw = input?.trim();
  if (!raw) return { ok: false, reason: 'FEN is empty.' };

  let chess: Chess;
  try {
    chess = new Chess(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Invalid FEN.';
    return { ok: false, reason: msg };
  }

  const board = chess.board();
  let whiteKings = 0;
  let blackKings = 0;
  let whitePieces = 0;
  let blackPieces = 0;
  let whitePawns = 0;
  let blackPawns = 0;

  for (const rank of board) {
    for (const sq of rank) {
      if (!sq) continue;
      if (sq.color === 'w') {
        whitePieces++;
        if (sq.type === 'k') whiteKings++;
        if (sq.type === 'p') whitePawns++;
      } else {
        blackPieces++;
        if (sq.type === 'k') blackKings++;
        if (sq.type === 'p') blackPawns++;
      }
    }
  }

  if (whiteKings !== 1 || blackKings !== 1) {
    return { ok: false, reason: 'Each side must have exactly one king.' };
  }
  if (whitePieces > 16 || blackPieces > 16) {
    return { ok: false, reason: 'A side cannot have more than 16 pieces.' };
  }
  if (whitePawns > 8 || blackPawns > 8) {
    return { ok: false, reason: 'A side cannot have more than 8 pawns.' };
  }

  // The side NOT to move cannot be in check (that would mean the previous
  // move left their own king in check — illegal).
  const sideToMove = chess.turn();
  if (chess.isCheckmate() || chess.isStalemate()) {
    return { ok: false, reason: 'Position is already checkmate or stalemate.' };
  }
  // Probe: swap turn, see if "opponent" appears to be in check.
  const swappedParts = chess.fen().split(' ');
  swappedParts[1] = sideToMove === 'w' ? 'b' : 'w';
  try {
    const probe = new Chess(swappedParts.join(' '));
    if (probe.isCheck()) {
      return { ok: false, reason: 'The side that just moved would be in check — illegal.' };
    }
  } catch {
    // If swapping the turn yields an invalid FEN (chess.js refuses), we treat
    // the original as suspect.
    return { ok: false, reason: 'Position appears inconsistent.' };
  }

  return { ok: true, fen: chess.fen(), sideToMove };
}

export const STANDARD_START_FEN = STANDARD_START;
