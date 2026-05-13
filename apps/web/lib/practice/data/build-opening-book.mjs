/**
 * One-off generator for opening-book.json.
 *
 * Fetches the five ECO-bucket TSVs from lichess-org/chess-openings (eco, name,
 * pgn — no FEN), replays each PGN with chess.js, and writes a compact map:
 *
 *   { "<epd>": [ecoCode, name], ... }
 *
 * Where <epd> = first 4 fields of FEN (board + side + castling + ep), which is
 * what we match challenge positions against. We keep only that prefix so two
 * positions that differ only in move clocks still match.
 *
 * Run with:  node apps/web/lib/practice/data/build-opening-book.mjs
 * Commit:    apps/web/lib/practice/data/opening-book.json
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const TSV_BUCKETS = ['a', 'b', 'c', 'd', 'e'];
const BASE = 'https://raw.githubusercontent.com/lichess-org/chess-openings/master';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'opening-book.json');

function epdOf(fen) {
  return fen.split(' ').slice(0, 4).join(' ');
}

function pgnToMoves(pgn) {
  // Lichess TSV pgn looks like: "1. e4 e5 2. Nf3 Nc6"
  return pgn
    .replace(/\d+\./g, '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const book = {};
  let total = 0;
  let failed = 0;

  for (const bucket of TSV_BUCKETS) {
    const url = `${BASE}/${bucket}.tsv`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
    const text = await res.text();
    const lines = text.split('\n');
    // Skip header.
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const [eco, name, pgn] = line.split('\t');
      if (!eco || !name || !pgn) continue;
      total++;
      try {
        const c = new Chess();
        for (const san of pgnToMoves(pgn)) {
          c.move(san);
        }
        const key = epdOf(c.fen());
        // Two entries can land on the same EPD via transposition. The
        // chess-openings file orders generic→specific, and the dedicated
        // "transposition" entries arrive later — so "last write wins" lands
        // on the more specific name. If that ever flips, switch to longest-
        // PGN-wins explicitly.
        book[key] = [eco, name];
      } catch (err) {
        failed++;
        if (failed < 5) console.warn(`fail: ${name} :: ${pgn} :: ${err.message}`);
      }
    }
  }

  writeFileSync(OUT, JSON.stringify(book));
  const sizeKb = Math.round(JSON.stringify(book).length / 1024);
  console.log(`wrote ${OUT}`);
  console.log(`entries: ${Object.keys(book).length} / ${total} rows (failed: ${failed}, ${sizeKb} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
