/**
 * Repro the /api/identify sample_pgn path locally so we can see the actual
 * error. Imports nothing from apps/web — only re-implements the same
 * sequence: parse PGN → extract features → rank.
 *
 * We bypass DB/Supabase/LLM and just exercise the algorithm.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Chess } from 'chess.js';

interface GameRowLite {
  color: 'white' | 'black';
  result: '1-0' | '0-1' | '1/2-1/2';
  time_class: string | null;
  opening_eco: string | null;
  ply_count: number;
  termination: string | null;
  opponent_rating: number | null;
  played_at: Date;
  move_seq_prefix?: string;
}

function inferTarget(blocks: Array<{ headers: Record<string, string> }>): string | null {
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

function splitGames(text: string): Array<{ headers: Record<string, string>; moveText: string }> {
  const normalized = text.replace(/\r\n/g, '\n');
  const blocks: Array<{ headers: Record<string, string>; moveText: string }> = [];
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

function parsePgnToGameRows(text: string, claimedHandle: string | null = null): GameRowLite[] {
  const blocks = splitGames(text);
  const target = (claimedHandle ?? inferTarget(blocks) ?? '').toLowerCase();
  console.log(`[repro] split into ${blocks.length} blocks; inferred target = "${target}"`);

  const out: GameRowLite[] = [];
  for (const b of blocks) {
    const h = b.headers;
    const result = h.Result;
    if (result !== '1-0' && result !== '0-1' && result !== '1/2-1/2') {
      console.log(`[repro] skip — bad result: ${result}`);
      continue;
    }
    const white = (h.White ?? '').toLowerCase();
    const black = (h.Black ?? '').toLowerCase();
    let targetIsWhite: boolean;
    if (target && (white === target || black === target)) {
      targetIsWhite = white === target;
    } else {
      console.log(`[repro] skip — target ${target} not in ${white}/${black}`);
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
          console.log(`[repro] chess.js returned null for move "${tok}"`);
          break;
        }
        if (movesSan.length < 12) movesSan.push(m.san);
        plies++;
      } catch (e) {
        valid = false;
        console.log(`[repro] chess.js threw on "${tok}": ${(e as Error).message}`);
        break;
      }
    }
    if (!valid || plies === 0) {
      console.log(
        `[repro] skip — invalid parse (plies=${plies}, valid=${valid}). first 100 chars of moveText: ${b.moveText.slice(0, 100)}`,
      );
      continue;
    }
    out.push({
      color: targetIsWhite ? 'white' : 'black',
      result,
      time_class: null,
      opening_eco: h.ECO ?? null,
      ply_count: plies,
      termination: h.Termination ?? null,
      opponent_rating: targetIsWhite
        ? h.BlackElo
          ? parseInt(h.BlackElo, 10)
          : null
        : h.WhiteElo
          ? parseInt(h.WhiteElo, 10)
          : null,
      played_at: new Date(),
      move_seq_prefix: movesSan.join(' '),
    });
  }
  return out;
}

const file = path.resolve(import.meta.dirname, '../../tmp/gelfand-sample.pgn');
const text = readFileSync(file, 'utf8');
console.log(`[repro] read ${text.length} chars from ${file}`);
const rows = parsePgnToGameRows(text);
console.log(`[repro] parsed ${rows.length} GameRows`);
for (const r of rows) {
  console.log(`  ${r.color} ECO=${r.opening_eco} plies=${r.ply_count} seq="${r.move_seq_prefix}"`);
}
