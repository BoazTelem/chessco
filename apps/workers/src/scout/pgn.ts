/**
 * Workers-side mirror of apps/web/lib/scout/pgn.ts — parse arbitrary PGN
 * pastes (lichess / chess.com / TWIC / pgnmentor / OTB tournament exports)
 * into GameRow values that match what features/run.ts produces from the
 * games table.
 *
 * Why a mirror: the workers stage3 CLI's --pgn mode previously called the
 * lichess-dumps parser, which requires a Lichess Site id and rejects every
 * other source. That made the headline `stage3 --pgn games.pgn --llm`
 * demo unusable for any real-world PGN.
 *
 * Both copies must stay in sync; future change is extraction to a shared
 * packages/scout-pgn module.
 */
import { Chess } from 'chess.js';
import type { GameRow } from '../features/extract';

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
  const normalized = text.replace(/\r\n/g, '\n');
  const blocks: PgnBlock[] = [];
  const lines = normalized.split('\n');
  let i = 0;
  while (i < lines.length) {
    while (i < lines.length && lines[i]!.trim() === '') i++;
    if (i >= lines.length) break;

    const headers: Record<string, string> = {};
    while (i < lines.length && lines[i]!.startsWith('[')) {
      const m = /^\[([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\]\s*$/.exec(lines[i]!);
      if (m) headers[m[1]!] = m[2]!.replace(/\\(["\\])/g, '$1');
      i++;
    }

    while (i < lines.length && lines[i]!.trim() === '') i++;

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
  // OTB tournament PGNs often omit [TimeControl] or mark it "-"; default to
  // classical so the time_class signal still contributes for the OTB
  // sample-game path. Online-source PGNs (lichess/chess.com) ship explicit
  // values like "300+0" / "180+2" / "correspondence".
  if (!tc || tc === '-' || tc === '?') return 'classical';
  const m = /^(\d+)(?:\+(\d+))?$/.exec(tc);
  if (!m) return tc === 'correspondence' ? 'correspondence' : 'classical';
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

function tokenizeMoves(text: string): string[] {
  let cleaned = text;
  cleaned = cleaned.replace(/\{[^}]*\}/g, ' ');
  for (let i = 0; i < 5; i++) cleaned = cleaned.replace(/\([^()]*\)/g, ' ');
  cleaned = cleaned.replace(/\$\d+/g, ' ');
  cleaned = cleaned.replace(/\d+\.+/g, ' ');
  cleaned = cleaned.replace(/[!?]+/g, '');
  return cleaned
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Parse a PGN text blob (one or many games) into GameRows.
 *
 * If `claimedHandle` is provided, that player is the target (we use their
 * color per game). If not provided, we infer the target by picking the
 * handle that appears most often across the paste — common case is the
 * user pastes one player's games and that handle appears in every game.
 * Games where the target isn't White or Black are skipped (otherwise we'd
 * contaminate the fingerprint with opponent ECO codes).
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
      continue;
    }

    const tokens = tokenizeMoves(b.moveText);
    const board = new Chess();
    const movesSan: string[] = [];
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
        if (movesSan.length < 12) movesSan.push(m.san);
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
      move_seq_prefix: movesSan.join(' '),
    });
  }

  return out;
}
