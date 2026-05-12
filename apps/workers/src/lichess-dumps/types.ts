/** Raw PGN headers as parsed out of `[Tag "value"]` lines. */
export interface PgnHeaders {
  Event?: string;
  Site?: string;
  Date?: string;
  Round?: string;
  White?: string;
  Black?: string;
  Result?: string;
  UTCDate?: string;
  UTCTime?: string;
  WhiteElo?: string;
  BlackElo?: string;
  WhiteRatingDiff?: string;
  BlackRatingDiff?: string;
  ECO?: string;
  Opening?: string;
  TimeControl?: string;
  Termination?: string;
  Variant?: string;
  [key: string]: string | undefined;
}

/** One parsed game from the PGN stream, before chess-logic processing. */
export interface ParsedGame {
  headers: PgnHeaders;
  /**
   * The "moves block" verbatim from the dump — SAN moves possibly
   * interleaved with %eval and %clk comments and result token at the end.
   */
  moveText: string;
  /** Byte offset in the decompressed stream where this game started. */
  byteOffset: number;
}

/** Categorized PGN time class derived from TimeControl header. */
export type TimeClass = 'bullet' | 'blitz' | 'rapid' | 'classical' | 'correspondence';

/** Result tag canonicalized. */
export type GameResult = '1-0' | '0-1' | '1/2-1/2' | '*';
