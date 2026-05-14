/**
 * Split a SAN move into a piece glyph + the remaining notation, so the move
 * list can render `Nxf7+` as `♘ xf7+` (Lichess / chess.com style).
 * Pawn moves, castles, and game-end annotations return a null glyph.
 */

const GLYPH: Record<string, string> = {
  N: '♘',
  B: '♗',
  R: '♖',
  Q: '♕',
  K: '♔',
};

export function splitSan(san: string): { glyph: string | null; rest: string } {
  if (!san) return { glyph: null, rest: '' };
  const first = san[0]!;
  const g = GLYPH[first];
  if (g) return { glyph: g, rest: san.slice(1) };
  return { glyph: null, rest: san };
}
