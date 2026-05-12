/**
 * Turn a ChesscomArchiveGame from /pub/player/{u}/games/{Y}/{M} into the
 * same ProcessedGame shape produced by the Lichess parser, so the existing
 * ingestBatch can write it to chessco-games.
 *
 * Mechanics differ from Lichess:
 *  - the PGN is bundled inside the archive JSON, not streamed from a file
 *  - metadata (rating, time_class, end_time) is available structurally, so
 *    we prefer those over re-parsing the PGN headers
 *  - source_game_id is the chess.com UUID when present, else the trailing
 *    integer in the game URL
 */
import { Chess } from 'chess.js';
import type { ChesscomArchiveGame } from '../lib/chesscom-api';
import { fenHash } from '../lichess-dumps/fen-hash';
import type { GameRow, MoveRow, PositionRow, ProcessedGame } from '../lichess-dumps/parse-game';
import type { GameResult, PgnHeaders, TimeClass } from '../lichess-dumps/types';

const HEADER_RE = /^\[([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\]$/;

/** chess.js board reused across games (same pattern as lichess-dumps parser). */
const board = new Chess();

export function processChesscomGame(game: ChesscomArchiveGame): ProcessedGame | null {
  const headers = extractPgnHeaders(game.pgn ?? '');
  const moveText = extractMoveText(game.pgn ?? '');
  if (!moveText) return null;

  const result = canonicalResult(headers.Result) ?? resultFromArchive(game);
  if (!result) return null;

  const sourceGameId = sourceIdFromArchive(game);
  if (!sourceGameId) return null;

  // chess.com gives us end_time in unix seconds; the PGN UTCDate/UTCTime is
  // also reliable but end_time is integer + always present.
  const playedAt = game.end_time
    ? new Date(game.end_time * 1000)
    : (parsePlayedAt(headers.UTCDate, headers.UTCTime) ?? null);
  if (!playedAt || !Number.isFinite(playedAt.getTime())) return null;

  const initialFen = headers.FEN && headers.SetUp === '1' ? headers.FEN : null;
  try {
    if (initialFen) board.load(initialFen);
    else board.reset();
  } catch {
    return null;
  }

  const positions: PositionRow[] = [];
  const moves: MoveRow[] = [];
  const eco = headers.ECO ?? null;
  const opening = openingNameFromHeaders(headers);

  const startFen = board.fen();
  positions.push({
    fen: startFen,
    fen_hash: fenHash(startFen),
    side_to_move: startFen.split(' ')[1] === 'b' ? 'b' : 'w',
    ply: 0,
    eco,
    opening_name: opening,
  });

  const tokens = tokenizeMoveText(moveText);
  let ply = 0;
  for (const tok of tokens) {
    if (tok.kind === 'comment') {
      const c = parseComment(tok.value);
      const last = moves[moves.length - 1];
      if (last) {
        if (c.clk !== null) {
          if (moves.length % 2 === 1) last.clock_white_ms = c.clk;
          else last.clock_black_ms = c.clk;
        }
      }
      continue;
    }
    if (tok.kind === 'result') break;
    if (tok.kind !== 'san') continue;

    const fenBefore = board.fen();
    let moveResult: {
      san: string;
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

  if (ply === 0) return null;

  const gameRow: GameRow = {
    source: 'chess.com',
    source_game_id: sourceGameId,
    white_handle_snapshot: game.white?.username?.toLowerCase() ?? null,
    black_handle_snapshot: game.black?.username?.toLowerCase() ?? null,
    white_rating: game.white?.rating ?? null,
    black_rating: game.black?.rating ?? null,
    pgn: game.pgn ?? '',
    initial_fen: initialFen,
    result,
    termination: chessomTermination(game, headers),
    time_control: game.time_control ?? headers.TimeControl ?? null,
    time_class: mapTimeClass(game.time_class),
    opening_eco: eco,
    opening_name: opening,
    ply_count: ply,
    played_at: playedAt,
  };

  return { game: gameRow, positions, moves };
}

// ---------------------------------------------------------------------------
// PGN string → headers + moveText
// ---------------------------------------------------------------------------

function extractPgnHeaders(pgn: string): PgnHeaders {
  const out: PgnHeaders = {};
  const lines = pgn.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith('[')) continue;
    const m = HEADER_RE.exec(line.trim());
    if (m) out[m[1]!] = unescapePgnQuoted(m[2]!);
  }
  return out;
}

function extractMoveText(pgn: string): string {
  // The moves block starts after the first blank line (between header block
  // and move block in standard PGN). chess.com follows the convention.
  const idx = pgn.search(/\r?\n\r?\n/);
  if (idx < 0) return '';
  return pgn.slice(idx).replace(/^\s+/, '').replace(/\s+$/, '');
}

function unescapePgnQuoted(s: string): string {
  return s.replace(/\\(["\\])/g, '$1');
}

// ---------------------------------------------------------------------------
// Move tokenization (close to lichess-dumps, minor differences in chess.com
// comments — they tend to be just [%clk H:MM:SS.s] or absent, no [%eval])
// ---------------------------------------------------------------------------

type MoveToken =
  | { kind: 'san'; value: string }
  | { kind: 'comment'; value: string }
  | { kind: 'result'; value: string }
  | { kind: 'move_number'; value: string };

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
      const end = text.indexOf('}', i + 1);
      if (end < 0) break;
      out.push({ kind: 'comment', value: text.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (c === '(') {
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
      while (i < text.length && text[i] !== ' ' && text[i] !== '\n') i++;
      continue;
    }
    let j = i;
    while (j < text.length && !' \t\r\n{('.includes(text[j]!)) j++;
    const tok = text.slice(i, j);
    i = j;

    if (tok === '1-0' || tok === '0-1' || tok === '1/2-1/2' || tok === '*') {
      out.push({ kind: 'result', value: tok });
      continue;
    }
    if (/^\d+\.+$/.test(tok)) {
      out.push({ kind: 'move_number', value: tok });
      continue;
    }
    const san = tok.replace(/[!?+#]+$/, '');
    if (san.length > 0) out.push({ kind: 'san', value: san });
  }
  return out;
}

function parseComment(c: string): { clk: number | null } {
  const m = /\[%clk\s+(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)\]/.exec(c);
  if (!m) return { clk: null };
  const h = Number.parseInt(m[1]!, 10);
  const mm = Number.parseInt(m[2]!, 10);
  const ss = Number.parseFloat(m[3]!);
  return { clk: Math.round((h * 3600 + mm * 60 + ss) * 1000) };
}

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

function canonicalResult(r: string | undefined): GameResult | null {
  if (r === '1-0' || r === '0-1' || r === '1/2-1/2') return r;
  return null;
}

function resultFromArchive(game: ChesscomArchiveGame): GameResult | null {
  // chess.com per-side result codes: 'win', 'checkmated', 'agreed', 'repetition',
  // 'timeout', 'resigned', 'stalemate', 'lose', 'insufficient', '50move',
  // 'abandoned', 'kingofthehill', 'threecheck', 'timevsinsufficient', 'bughousepartnerlose'.
  const wr = game.white?.result;
  const br = game.black?.result;
  if (wr === 'win') return '1-0';
  if (br === 'win') return '0-1';
  const drawCodes = new Set([
    'agreed',
    'repetition',
    'stalemate',
    'insufficient',
    '50move',
    'timevsinsufficient',
  ]);
  if ((wr && drawCodes.has(wr)) || (br && drawCodes.has(br))) return '1/2-1/2';
  return null;
}

function chessomTermination(game: ChesscomArchiveGame, headers: PgnHeaders): string | null {
  if (headers.Termination) return headers.Termination;
  // Synthesize from per-side codes if PGN didn't include the tag.
  const wr = game.white?.result;
  const br = game.black?.result;
  if (wr && br) return `${wr}/${br}`;
  return null;
}

function sourceIdFromArchive(game: ChesscomArchiveGame): string | null {
  if (game.uuid) return game.uuid;
  const m = /\/(\d+)(?:\?.*)?$/.exec(game.url ?? '');
  return m?.[1] ?? null;
}

function mapTimeClass(tc: ChesscomArchiveGame['time_class'] | undefined): TimeClass | null {
  switch (tc) {
    case 'bullet':
      return 'bullet';
    case 'blitz':
      return 'blitz';
    case 'rapid':
      return 'rapid';
    case 'daily':
      return 'correspondence';
    default:
      return null;
  }
}

function openingNameFromHeaders(h: PgnHeaders): string | null {
  if (h.Opening) return h.Opening;
  // chess.com sometimes ships ECOUrl like
  // https://www.chess.com/openings/Sicilian-Defense-Najdorf-Variation
  if (h.ECOUrl) {
    const tail = h.ECOUrl.split('/').pop() ?? '';
    return tail.replace(/-/g, ' ').trim() || null;
  }
  return null;
}

function parsePlayedAt(date: string | undefined, time: string | undefined): Date | null {
  if (!date || date.startsWith('?')) return null;
  const [y, m, d] = date.split('.').map((s) => Number.parseInt(s, 10));
  if (!y || !m || !d) return null;
  const t = time ?? '00:00:00';
  const [hh, mm, ss] = t.split(':').map((s) => Number.parseInt(s, 10));
  const dt = new Date(Date.UTC(y, m - 1, d, hh || 0, mm || 0, ss || 0));
  return Number.isFinite(dt.getTime()) ? dt : null;
}
