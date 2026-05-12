/**
 * Turn a ParsedGame (headers + raw moveText) into the row tuples our
 * batch inserter writes to Cloud SQL.
 *
 * One game produces:
 *   - 1 row for games
 *   - N rows for positions (deduped on FEN downstream)
 *   - N rows for moves (one per ply)
 */
import { Chess } from 'chess.js';
import { fenHash } from './fen-hash';
import type { GameResult, ParsedGame, PgnHeaders, TimeClass } from './types';

export interface GameRow {
  source: 'lichess' | 'chess.com';
  source_game_id: string;
  white_handle_snapshot: string | null;
  black_handle_snapshot: string | null;
  white_rating: number | null;
  black_rating: number | null;
  pgn: string;
  initial_fen: string | null;
  result: GameResult;
  termination: string | null;
  time_control: string | null;
  time_class: TimeClass | null;
  opening_eco: string | null;
  opening_name: string | null;
  ply_count: number;
  played_at: Date;
}

export interface PositionRow {
  fen: string;
  fen_hash: bigint;
  side_to_move: 'w' | 'b';
  ply: number;
  eco: string | null;
  opening_name: string | null;
}

export interface MoveRow {
  ply: number;
  san: string;
  uci: string;
  fen_before: string;
  fen_after: string;
  clock_white_ms: number | null;
  clock_black_ms: number | null;
  eval_cp: number | null;
  eval_mate: number | null;
}

export interface ProcessedGame {
  game: GameRow;
  positions: PositionRow[];
  moves: MoveRow[];
}

/** chess.js wraps an instance for board state. Reusing across games. */
const board = new Chess();

/**
 * Process one ParsedGame. Returns null if the moves can't be parsed
 * (Lichess sometimes ships partial games or odd termination tokens).
 */
export function processGame(g: ParsedGame): ProcessedGame | null {
  const h = g.headers;
  const result = canonicalResult(h.Result);
  if (!result) return null;

  const sourceGameId = extractSourceGameId(h.Site ?? '');
  if (!sourceGameId) return null;

  const playedAt = parsePlayedAt(h.UTCDate, h.UTCTime) ?? parsePlayedAt(h.Date, undefined);
  if (!playedAt) return null;

  // Reset board to either custom FEN (rare for Lichess) or standard start.
  const initialFen = h.FEN && h.SetUp === '1' ? h.FEN : null;
  try {
    if (initialFen) {
      board.load(initialFen);
    } else {
      board.reset();
    }
  } catch {
    return null;
  }

  const positions: PositionRow[] = [];
  const moves: MoveRow[] = [];
  const eco = h.ECO ?? null;
  const opening = h.Opening ?? null;

  // First "position" is the starting position (ply 0).
  const startFen = board.fen();
  positions.push({
    fen: startFen,
    fen_hash: fenHash(startFen),
    side_to_move: startFen.split(' ')[1] === 'b' ? 'b' : 'w',
    ply: 0,
    eco,
    opening_name: opening,
  });

  const tokens = tokenizeMoveText(g.moveText);
  let ply = 0;
  for (const tok of tokens) {
    if (tok.kind === 'comment') {
      const c = parseLichessComment(tok.value);
      // Attach to the most recent move row (if any).
      const last = moves[moves.length - 1];
      if (last) {
        if (c.clk !== null) {
          // Lichess %clk shows the clock AFTER the move was made — assign
          // to the player who just moved (i.e. opposite of side-to-move
          // before this move). At ply N (1-indexed), white moves on odd N.
          if (moves.length % 2 === 1) last.clock_white_ms = c.clk;
          else last.clock_black_ms = c.clk;
        }
        if (c.evalCp !== null) last.eval_cp = c.evalCp;
        if (c.evalMate !== null) last.eval_mate = c.evalMate;
      }
      continue;
    }
    if (tok.kind === 'result') break;
    if (tok.kind !== 'san') continue;

    const fenBefore = board.fen();
    let moveResult: {
      san: string;
      lan: string;
      from: string;
      to: string;
      promotion?: string;
    } | null = null;
    try {
      moveResult = board.move(tok.value);
    } catch {
      return null;
    }
    if (!moveResult) return null;

    ply++;
    const fenAfter = board.fen();
    const uci = moveResult.from + moveResult.to + (moveResult.promotion ?? '');

    positions.push({
      fen: fenAfter,
      fen_hash: fenHash(fenAfter),
      side_to_move: fenAfter.split(' ')[1] === 'b' ? 'b' : 'w',
      ply,
      // ECO/opening tags only apply to the opening — leave null on later plies.
      eco: ply <= 12 ? eco : null,
      opening_name: ply <= 12 ? opening : null,
    });

    moves.push({
      ply,
      san: moveResult.san,
      uci,
      fen_before: fenBefore,
      fen_after: fenAfter,
      clock_white_ms: null,
      clock_black_ms: null,
      eval_cp: null,
      eval_mate: null,
    });
  }

  // Lichess sometimes ships header-only games (no moves). Reject.
  if (ply === 0) return null;

  return {
    game: {
      source: 'lichess',
      source_game_id: sourceGameId,
      white_handle_snapshot: h.White ?? null,
      black_handle_snapshot: h.Black ?? null,
      white_rating: parseIntOrNull(h.WhiteElo),
      black_rating: parseIntOrNull(h.BlackElo),
      pgn: rebuildPgn(h, g.moveText),
      initial_fen: initialFen,
      result,
      termination: h.Termination ?? null,
      time_control: h.TimeControl ?? null,
      time_class: classifyTimeControl(h.TimeControl),
      opening_eco: eco,
      opening_name: opening,
      ply_count: ply,
      played_at: playedAt,
    },
    positions,
    moves,
  };
}

/**
 * Re-emit a PGN string from parsed headers + raw moveText. We preserve
 * Lichess `%eval` and `%clk` comments verbatim (they ride inside moveText)
 * so a downstream Stockfish-or-eval extractor can recover engine evals
 * without re-analyzing the game. Header values get their inner double
 * quotes backslash-escaped per PGN spec.
 */
function rebuildPgn(headers: PgnHeaders, moveText: string): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null || value === '') continue;
    lines.push(`[${key} "${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`);
  }
  return lines.length > 0 ? `${lines.join('\n')}\n\n${moveText}` : moveText;
}

function canonicalResult(r: string | undefined): GameResult | null {
  if (r === '1-0' || r === '0-1' || r === '1/2-1/2') return r;
  return null;
}

function extractSourceGameId(site: string): string | null {
  // 'https://lichess.org/abcdefgh' or 'https://lichess.org/abcdefgh/white'
  const m = /lichess\.org\/([a-zA-Z0-9]{8})/.exec(site);
  return m?.[1] ?? null;
}

function parsePlayedAt(date: string | undefined, time: string | undefined): Date | null {
  if (!date || date.startsWith('?')) return null;
  const [y, m, d] = date.split('.').map((s) => Number.parseInt(s, 10));
  if (!y || !m || !d) return null;
  const t = time ?? '00:00:00';
  const [hh, mm, ss] = t.split(':').map((s) => Number.parseInt(s, 10));
  // UTC because Lichess uses UTCDate/UTCTime.
  const dt = new Date(Date.UTC(y, m - 1, d, hh || 0, mm || 0, ss || 0));
  return Number.isFinite(dt.getTime()) ? dt : null;
}

function parseIntOrNull(s: string | undefined): number | null {
  if (!s || s === '?') return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function classifyTimeControl(tc: string | undefined): TimeClass | null {
  // Lichess time control format: "base+inc" in seconds, e.g. "300+0", "180+2".
  if (!tc || tc === '-') return null;
  const m = /^(\d+)(?:\+(\d+))?$/.exec(tc);
  if (!m) return tc === 'correspondence' ? 'correspondence' : null;
  const base = Number.parseInt(m[1]!, 10);
  const inc = Number.parseInt(m[2] ?? '0', 10);
  // Lichess convention (estimated total time = base + 40*inc):
  const est = base + 40 * inc;
  if (est < 30) return 'bullet';
  if (est < 180) return 'bullet';
  if (est < 480) return 'blitz';
  if (est < 1500) return 'rapid';
  return 'classical';
}

type MoveToken =
  | { kind: 'san'; value: string }
  | { kind: 'comment'; value: string }
  | { kind: 'result'; value: string }
  | { kind: 'move_number'; value: string };

/**
 * Split a Lichess moveText into tokens. Handles:
 *   1. e4 { [%eval 0.0] [%clk 0:05:00] } e5
 *   1... Nf6   (after black move ellipsis)
 *   $4 / !? / !! / ?! / ?? / +/- annotations (we strip)
 *   1-0, 0-1, 1/2-1/2, * (result tokens, end of game)
 */
function tokenizeMoveText(text: string): MoveToken[] {
  const out: MoveToken[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    if (c === '{') {
      // Comment runs to matching '}'.
      const end = text.indexOf('}', i + 1);
      if (end < 0) break;
      out.push({ kind: 'comment', value: text.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (c === '(') {
      // Variation — Lichess dumps don't include these in main moves, skip.
      let depth = 1;
      i++;
      while (i < text.length && depth > 0) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')') depth--;
        i++;
      }
      continue;
    }
    if (c === '$') {
      // NAG (numeric annotation glyph) — skip to next whitespace.
      while (i < text.length && text[i] !== ' ' && text[i] !== '\n') i++;
      continue;
    }
    // Read next non-whitespace token.
    let j = i;
    while (j < text.length && !' \t\r\n{('.includes(text[j]!)) j++;
    const tok = text.slice(i, j);
    i = j;

    if (tok === '1-0' || tok === '0-1' || tok === '1/2-1/2' || tok === '*') {
      out.push({ kind: 'result', value: tok });
      continue;
    }
    if (/^\d+\.+$/.test(tok)) {
      // Move number, e.g. '1.' or '12...'.
      out.push({ kind: 'move_number', value: tok });
      continue;
    }
    // Strip trailing annotation glyphs like '!?', '?', '+/-', etc.
    const san = tok.replace(/[!?+#]+$/, '');
    if (san.length > 0) {
      out.push({ kind: 'san', value: san });
    }
  }
  return out;
}

/**
 * Parse Lichess move comments like:
 *   [%eval 1.23] [%eval #5] [%clk 0:04:59]
 * Returns clock in ms, eval in centipawns (or mate-in-N).
 */
function parseLichessComment(c: string): {
  clk: number | null;
  evalCp: number | null;
  evalMate: number | null;
} {
  let clk: number | null = null;
  let evalCp: number | null = null;
  let evalMate: number | null = null;

  const clkM = /\[%clk\s+(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)\]/.exec(c);
  if (clkM) {
    const h = Number.parseInt(clkM[1]!, 10);
    const m = Number.parseInt(clkM[2]!, 10);
    const s = Number.parseFloat(clkM[3]!);
    clk = Math.round((h * 3600 + m * 60 + s) * 1000);
  }
  const evM = /\[%eval\s+(#?-?\d+(?:\.\d+)?)\]/.exec(c);
  if (evM) {
    const v = evM[1]!;
    if (v.startsWith('#')) {
      evalMate = Number.parseInt(v.slice(1), 10);
    } else {
      evalCp = Math.round(Number.parseFloat(v) * 100);
    }
  }
  return { clk, evalCp, evalMate };
}
