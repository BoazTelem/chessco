// PGN parsing, FEN helpers, engine helpers, opening-tree builders.
// Populated as needed in Phase 0 Week 5 (PGN import) and Phase 1.

export const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' as const;

export type Fen = string;
export type San = string;
export type Uci = string;
