/**
 * Server-only opening detection. The board is the single source of truth —
 * we never let users self-tag the opening on a Practice challenge. Instead,
 * the API route looks the FEN up in a bundled EPD→name book at publish time
 * and stores the result (or null if the position isn't a known book line).
 *
 * The book is generated from lichess-org/chess-openings via
 * `data/build-opening-book.mjs`. ~3700 positions covering all common ECO
 * lines; ~430KB JSON loaded once into the server process.
 *
 * Most user-published positions won't be book lines (custom middlegame
 * studies, endgames, tactical puzzles) — they correctly return null.
 */

import book from './data/opening-book.json';

type BookEntry = [eco: string, name: string];
const BOOK = book as unknown as Record<string, BookEntry>;

export interface DetectedOpening {
  ecoCode: string;
  /** Full Lichess-style name, e.g. "Sicilian Defense: Najdorf Variation". */
  name: string;
}

/**
 * Returns the opening that the FEN's position is reached by, or null if the
 * position isn't in the book. Matches on the EPD (board + side + castling +
 * ep) — move clocks are ignored, so transposition into a book position from
 * a different move order still hits.
 */
export function detectOpening(fen: string): DetectedOpening | null {
  const epd = fen.split(' ').slice(0, 4).join(' ');
  const hit = BOOK[epd];
  if (!hit) return null;
  return { ecoCode: hit[0], name: hit[1] };
}
