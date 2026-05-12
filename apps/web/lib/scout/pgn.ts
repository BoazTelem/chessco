/**
 * Minimal PGN-text → GameRow parser for the web sample-game flow.
 *
 * Trimmed-down mirror of apps/workers/src/lichess-dumps/pgn-stream +
 * parse-game. Doesn't need to be production-throughput like the dump
 * worker; just has to handle a paste of 1-30 games reliably.
 *
 * Strategy: split blocks separated by blank-line-after-moves, parse
 * headers + moves, run through chess.js for legality check + final
 * board state. Reject games that don't parse cleanly.
 */
import { Chess } from 'chess.js';
import type { GameRow } from './features';

interface PgnBlock {
  headers: Record<string, string>;
  moveText: string;
}

/** Pick the handle that appears most often across the paste. */
function inferTargetHandle(blocks: PgnBlock[]): string | null {
  const counts = new Map<string, number>();
  for (const b of blocks) {
    const w = (b.headers.White ?? '').toLowerCase().trim();
    const bk = (b.headers.Black ?? '').toLowerCase().trim();
    if (w) counts.set(w, (counts.get(w) ?? 0) + 1);
    if (bk) counts.set(bk, (counts.get(bk) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [h, c] of counts) {
    if (c > bestCount) {
      best = h;
      bestCount = c;
    }
  }
  return best;
}

function splitGames(text: string): PgnBlock[] {
  // Normalize line endings; PGN allows \r\n or \n.
  const normalized = text.replace(/\r\n/g, '\n');
  const blocks: PgnBlock[] = [];
  const lines = normalized.split('\n');
  let i = 0;
  while (i < lines.length) {
    // Skip blank lines between games.
    while (i < lines.length && lines[i]!.trim() === '') i++;
    if (i >= lines.length) break;

    // Read header block.
    const headers: Record<string, string> = {};
    while (i < lines.length && lines[i]!.startsWith('[')) {
      const m = /^\[([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\]\s*$/.exec(lines[i]!);
      if (m) headers[m[1]!] = m[2]!.replace(/\\(["\\])/g, '$1');
      i++;
    }

    // Skip blank line between headers and moves.
    while (i < lines.length && lines[i]!.trim() === '') i++;

    // Read move text until next blank or next header.
    const moveLines: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && !lines[i]!.startsWith('[')) {
      moveLines.push(lines[i]!);
      i++;
    }

    if (Object.keys(headers).length > 0 && moveLines.length > 0) {
      blocks.push({ headers, moveText: moveLines.join(' ').trim() });
    }
  }
  return blocks;
}

function classifyTimeControl(tc: string | undefined): string | null {
  if (!tc || tc === '-') return null;
  const m = /^(\d+)(?:\+(\d+))?$/.exec(tc);
  if (!m) return tc === 'correspondence' ? 'correspondence' : null;
  const base = Number.parseInt(m[1]!, 10);
  const inc = Number.parseInt(m[2] ?? '0', 10);
  const est = base + 40 * inc;
  if (est < 180) return 'bullet';
  if (est < 480) return 'blitz';
  if (est < 1500) return 'rapid';
  return 'classical';
}

function parsePlayedAt(date?: string, time?: string): Date | null {
  if (!date || date.startsWith('?')) return null;
  const [y, m, d] = date.split('.').map((s) => Number.parseInt(s, 10));
  if (!y || !m || !d) return null;
  const t = time ?? '00:00:00';
  const [hh, mm, ss] = t.split(':').map((s) => Number.parseInt(s, 10));
  const dt = new Date(Date.UTC(y, m - 1, d, hh || 0, mm || 0, ss || 0));
  return Number.isFinite(dt.getTime()) ? dt : null;
}

/**
 * Strip PGN comments {…}, variations (…), NAGs $N, then split on whitespace.
 * Returns a clean list of SAN tokens + result token (1-0, 0-1, 1/2-1/2, *).
 */
function tokenizeMoves(text: string): string[] {
  let cleaned = text;
  // Remove comments (could nest in pathological PGNs but Lichess/chess.com don't)
  cleaned = cleaned.replace(/\{[^}]*\}/g, ' ');
  // Remove variations (single-level; nested is rare)
  for (let i = 0; i < 5; i++) cleaned = cleaned.replace(/\([^()]*\)/g, ' ');
  // Remove NAGs
  cleaned = cleaned.replace(/\$\d+/g, ' ');
  // Remove move numbers like "1." or "12..."
  cleaned = cleaned.replace(/\d+\.+/g, ' ');
  // Remove annotation glyphs at end of tokens (!?, !!, ??, +!, etc.)
  cleaned = cleaned.replace(/[!?]+/g, '');

  return cleaned
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Parse a PGN text blob (one or many games) into GameRows.
 *
 * If `claimedHandle` is provided, that player is the target (we use
 * their color per game). If not provided, we infer the target by
 * picking the handle that appears most often across the paste — this
 * matches the common case where the user pasted "all my opponent's
 * games" and that handle appears in every game.
 */
export function parsePgnToGameRows(text: string, claimedHandle: string | null = null): GameRow[] {
  const blocks = splitGames(text);
  const target = (claimedHandle ?? inferTargetHandle(blocks) ?? '').toLowerCase();

  const out: GameRow[] = [];
  for (const b of blocks) {
    const h = b.headers;
    const result = h.Result;
    if (result !== '1-0' && result !== '0-1' && result !== '1/2-1/2') continue;

    const playedAt =
      parsePlayedAt(h.UTCDate, h.UTCTime) ?? parsePlayedAt(h.Date, undefined) ?? new Date();

    const white = (h.White ?? '').toLowerCase();
    const black = (h.Black ?? '').toLowerCase();
    let targetIsWhite: boolean;
    if (target && (white === target || black === target)) {
      targetIsWhite = white === target;
    } else {
      // Target not in this game — skip; otherwise we'd contaminate the
      // fingerprint with opponent ECO codes.
      continue;
    }

    const tokens = tokenizeMoves(b.moveText);
    const board = new Chess();
    let plies = 0;
    let valid = true;
    for (const tok of tokens) {
      if (tok === '1-0' || tok === '0-1' || tok === '1/2-1/2' || tok === '*') break;
      try {
        const m = board.move(tok);
        if (!m) {
          valid = false;
          break;
        }
        plies++;
      } catch {
        valid = false;
        break;
      }
    }
    if (!valid || plies === 0) continue;

    out.push({
      color: targetIsWhite ? 'white' : 'black',
      result,
      time_class: classifyTimeControl(h.TimeControl),
      opening_eco: h.ECO ?? null,
      ply_count: plies,
      termination: h.Termination ?? null,
      opponent_rating: targetIsWhite
        ? h.BlackElo
          ? Number.parseInt(h.BlackElo, 10)
          : null
        : h.WhiteElo
          ? Number.parseInt(h.WhiteElo, 10)
          : null,
      played_at: playedAt,
    });
  }

  return out;
}
