import { Chess } from 'chess.js';
import type { Color, GameRecord, GameResult, TimeClass } from './types';

function normalizeFenKey(fen: string): string {
  const parts = fen.split(' ');
  return parts.slice(0, 4).join(' ');
}

function classifyTimeControl(tc: string | undefined): TimeClass {
  if (!tc) return 'unknown';
  const [baseStr, incStr] = tc.split('+');
  const base = Number(baseStr);
  if (!Number.isFinite(base)) return 'unknown';
  const inc = Number(incStr ?? '0') || 0;
  const total = base + 40 * inc;
  if (total < 180) return 'bullet';
  if (total < 600) return 'blitz';
  if (total < 1800) return 'rapid';
  return 'classical';
}

function resultFor(white: string | undefined, color: Color): GameResult {
  if (white === '1/2-1/2') return 'draw';
  if (white === '1-0') return color === 'white' ? 'win' : 'loss';
  if (white === '0-1') return color === 'black' ? 'win' : 'loss';
  return 'draw';
}

function parseDate(date: string | undefined, utcDate: string | undefined): Date | null {
  const raw = (utcDate ?? date ?? '').replace(/\./g, '-');
  if (!raw || raw === '????-??-??') return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

export interface ParsePgnOptions {
  /** Lower-cased target player handle. */
  targetHandle: string;
  /** Stable game id (lichess id, chess.com url, or random). */
  fallbackId: string;
  /** Explicit played-at if the caller already knows it (chess.com end_time). */
  playedAtOverride?: Date;
  /** Explicit time-class override (chess.com gives us this directly). */
  timeClassOverride?: TimeClass;
}

export function parsePgn(pgn: string, opts: ParsePgnOptions): GameRecord | null {
  const game = new Chess();
  try {
    game.loadPgn(pgn, { strict: false });
  } catch {
    return null;
  }
  const headers = game.header() as Record<string, string | undefined>;
  const target = opts.targetHandle.toLowerCase();
  const white = (headers.White ?? '').toLowerCase();
  const black = (headers.Black ?? '').toLowerCase();
  let playerColor: Color;
  if (white === target) playerColor = 'white';
  else if (black === target) playerColor = 'black';
  else return null;

  const result = resultFor(headers.Result, playerColor);
  const resultText =
    headers.Result === '1-0' || headers.Result === '0-1' || headers.Result === '1/2-1/2'
      ? headers.Result
      : '1/2-1/2';
  const playedAt = opts.playedAtOverride ?? parseDate(headers.Date, headers.UTCDate);
  if (!playedAt) return null;

  const timeClass = opts.timeClassOverride ?? classifyTimeControl(headers.TimeControl);
  const whiteElo = Number(headers.WhiteElo);
  const blackElo = Number(headers.BlackElo);

  const history = game.history({ verbose: true });
  if (history.length === 0) return null;

  const movesSan: string[] = [];
  const movesUci: string[] = [];
  const fensBefore: string[] = [];
  const walker = new Chess();
  for (const move of history) {
    fensBefore.push(normalizeFenKey(walker.fen()));
    movesSan.push(move.san);
    movesUci.push(move.from + move.to + (move.promotion ?? ''));
    walker.move({ from: move.from, to: move.to, promotion: move.promotion });
  }

  const idFromHeader = headers.Site?.split('/').pop() ?? headers.GameId;
  return {
    id: opts.fallbackId || idFromHeader || '',
    playedAt,
    playerColor,
    result,
    resultText,
    timeClass,
    whiteHandle: headers.White ?? '',
    blackHandle: headers.Black ?? '',
    whiteElo: Number.isFinite(whiteElo) && whiteElo > 0 ? whiteElo : null,
    blackElo: Number.isFinite(blackElo) && blackElo > 0 ? blackElo : null,
    movesSan,
    movesUci,
    fensBefore,
  };
}

export { normalizeFenKey };
