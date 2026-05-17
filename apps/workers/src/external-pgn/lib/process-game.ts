/**
 * TWIC/external-PGN → ProcessedGame transformer.
 *
 * Mirrors the Lichess-specific apps/workers/src/lichess-dumps/parse-game.ts
 * `processGame` but adapted to PGN shapes from external public databases:
 *   - source_game_id supplied by caller (the synthetic source_url we already
 *     stored on the external_pgn_sources row, e.g. "twic://1521/0")
 *   - played_at parsed from PGN Date header alone (no UTCDate/UTCTime)
 *   - no Lichess %clk / %eval comment payloads — TWIC games don't carry them
 *   - time_class left null when TimeControl isn't structured the same as
 *     Lichess; downstream fingerprint extractor handles null time_class
 *
 * Returns null when the move text can't be re-played (rare; a few percent
 * of TWIC games per issue have non-standard tokens or partial annotations).
 * Callers count nulls and continue.
 */
import { Chess } from 'chess.js';
import { fenHash } from '../../lichess-dumps/fen-hash';
import type { GameResult, ParsedGame, PgnHeaders } from '../../lichess-dumps/types';
import type { GameRow, MoveRow, PositionRow, ProcessedGame } from '../../lichess-dumps/parse-game';

// Reuse one chess.js board across calls to avoid per-game allocation cost.
const board = new Chess();

export interface ProcessExternalGameInput {
  /** The parsed PGN headers + move text. */
  game: ParsedGame;
  /** Maps directly into games.source. Must satisfy the CHECK constraint. */
  source: GameRow['source'];
  /** Stable id within the source — for TWIC this is the source_url stored
   *  on external_pgn_sources (e.g. "twic://1521/0"). */
  sourceGameId: string;
}

export function processExternalGame(input: ProcessExternalGameInput): ProcessedGame | null {
  const { game: g, source, sourceGameId } = input;
  const h = g.headers;

  const result = canonicalResult(h.Result);
  if (!result) return null;

  const playedAt = parsePgnDate(h.Date);
  if (!playedAt) return null;

  // External PGNs almost never include SetUp/FEN; default to standard start.
  const initialFen = h.FEN && h.SetUp === '1' ? h.FEN : null;
  try {
    if (initialFen) board.load(initialFen);
    else board.reset();
  } catch {
    return null;
  }

  const positions: PositionRow[] = [];
  const moves: MoveRow[] = [];
  const eco = h.ECO ?? null;
  const opening = h.Opening ?? null;

  // Starting position (ply 0).
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
    if (tok.kind === 'comment') continue; // No %clk/%eval to harvest.
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

  return {
    game: {
      source,
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
      time_class: null, // TWIC events don't expose a standard time_class string.
      opening_eco: eco,
      opening_name: opening,
      ply_count: ply,
      played_at: playedAt,
    },
    positions,
    moves,
  };
}

function canonicalResult(r: string | undefined): GameResult | null {
  if (r === '1-0' || r === '0-1' || r === '1/2-1/2') return r;
  return null;
}

/** Parse "YYYY.MM.DD" (PGN standard). TWIC sometimes uses "??" for unknown
 *  parts ("2023.??.??"); fall back to YYYY-01-01 in that case, since the
 *  partition key requires a non-null date and the matcher only filters by
 *  recency in months. */
function parsePgnDate(raw: string | undefined): Date | null {
  if (!raw || raw.startsWith('?')) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const y = Number.parseInt(parts[0]!, 10);
  if (!Number.isFinite(y) || y < 1900 || y > 2100) return null;
  const mRaw = parts[1] ?? '01';
  const dRaw = parts[2] ?? '01';
  const m = Number.parseInt(mRaw, 10);
  const d = Number.parseInt(dRaw, 10);
  const dt = new Date(
    Date.UTC(
      y,
      Number.isFinite(m) && m >= 1 && m <= 12 ? m - 1 : 0,
      Number.isFinite(d) && d >= 1 && d <= 31 ? d : 1,
    ),
  );
  return Number.isFinite(dt.getTime()) ? dt : null;
}

function parseIntOrNull(s: string | undefined): number | null {
  if (!s || s === '?') return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function rebuildPgn(headers: PgnHeaders, moveText: string): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null || value === '') continue;
    lines.push(`[${key} "${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`);
  }
  return lines.length > 0 ? `${lines.join('\n')}\n\n${moveText}` : moveText;
}

// ---------------------------------------------------------------------------
// Move-text tokeniser — local copy of the Lichess one (kept private there).
// ---------------------------------------------------------------------------
type MoveToken =
  | { kind: 'san'; value: string }
  | { kind: 'comment'; value: string }
  | { kind: 'result'; value: string };

const SAN_RE = /([NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](?:=[NBRQ])?[+#]?|O-O(?:-O)?[+#]?)/g;

function tokenizeMoveText(text: string): MoveToken[] {
  const out: MoveToken[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '{') {
      const end = text.indexOf('}', i);
      if (end < 0) break;
      out.push({ kind: 'comment', value: text.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (c === '(') {
      // Skip variation. TWIC sometimes embeds variations; we drop them.
      let depth = 1;
      i++;
      while (i < text.length && depth > 0) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')') depth--;
        i++;
      }
      continue;
    }
    if (c === '1' || c === '0' || c === '*') {
      const rest = text.slice(i);
      if (rest.startsWith('1-0')) {
        out.push({ kind: 'result', value: '1-0' });
        return out;
      }
      if (rest.startsWith('0-1')) {
        out.push({ kind: 'result', value: '0-1' });
        return out;
      }
      if (rest.startsWith('1/2-1/2')) {
        out.push({ kind: 'result', value: '1/2-1/2' });
        return out;
      }
      if (rest.startsWith('*')) {
        out.push({ kind: 'result', value: '*' });
        return out;
      }
    }
    if (c >= '0' && c <= '9') {
      // Move number or "1." / "1..." prefix — skip to next non-digit/dot/space.
      while (i < text.length && text[i]! >= '0' && text[i]! <= '9') i++;
      while (i < text.length && (text[i] === '.' || text[i] === ' ')) i++;
      continue;
    }
    if (c === '$') {
      // NAG (e.g. "$1"). Skip to space.
      while (i < text.length && text[i] !== ' ' && text[i] !== '\n') i++;
      continue;
    }
    // Attempt SAN match at this position.
    SAN_RE.lastIndex = 0;
    const m = SAN_RE.exec(text.slice(i));
    if (m && m.index === 0) {
      out.push({ kind: 'san', value: m[0] });
      i += m[0].length;
      continue;
    }
    // Unknown token — advance one char.
    i++;
  }
  return out;
}
