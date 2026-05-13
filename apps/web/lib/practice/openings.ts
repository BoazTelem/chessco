/**
 * Common chess opening names — used as a datalist for the optional
 * "Opening" field on the create-challenge form, and shown as filter
 * options on the lobby when challenges tag themselves.
 *
 * v1 is hand-curated (~40 most-played openings). The list is intentionally
 * short so the dropdown stays scannable; users can free-type anything that
 * isn't on the list. Auto-detection from the FEN/PGN is out of scope here.
 */

export const COMMON_OPENINGS = [
  // Open games (1.e4 e5)
  'Italian Game',
  'Ruy Lopez',
  'Scotch Game',
  'Petroff Defense',
  'Philidor Defense',
  "King's Gambit",
  'Vienna Game',
  'Four Knights Game',

  // Semi-open (1.e4 vs anything else)
  'Sicilian Defense',
  'French Defense',
  'Caro-Kann Defense',
  'Pirc Defense',
  'Modern Defense',
  'Scandinavian Defense',
  'Alekhine Defense',

  // 1.d4 closed games
  "Queen's Gambit Accepted",
  "Queen's Gambit Declined",
  'Slav Defense',
  'Semi-Slav Defense',
  'Catalan Opening',

  // 1.d4 Indian defenses
  "King's Indian Defense",
  'Nimzo-Indian Defense',
  "Queen's Indian Defense",
  'Grünfeld Defense',
  'Benoni Defense',
  'Dutch Defense',

  // Flank openings
  'English Opening',
  'Réti Opening',
  'Bird Opening',
  'Larsen Opening',

  // Endgames / studies
  'King and Pawn endgame',
  'Rook endgame',
  'Knight and Bishop endgame',
  'Queen vs Rook endgame',
  'Lucena position',
  'Philidor position',

  // Generic buckets
  'Middlegame study',
  'Tactical puzzle',
] as const;

export type OpeningName = (typeof COMMON_OPENINGS)[number] | (string & {});
