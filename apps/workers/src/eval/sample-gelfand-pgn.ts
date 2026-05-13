/**
 * One-shot: split Gelfand.pgn (pgnmentor archive) → pick 8 most recent
 * games where Gelfand was actually a player → emit a single concatenated
 * PGN to gelfand-sample.pgn for use as a sample_pgn paste.
 *
 *   pnpm --filter @chessco/workers exec tsx src/eval/sample-gelfand-pgn.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const INPUT = path.resolve(import.meta.dirname, '../../tmp/Gelfand.pgn');
const OUTPUT = path.resolve(import.meta.dirname, '../../tmp/gelfand-sample.pgn');
// pgnmentor uses both "Gelfand, Boris" and "Gelfand,B" — match either.
const TARGET_REGEX = /\[(White|Black) "Gelfand,\s*(Boris|B)"\]/i;
const SAMPLE_SIZE = 8;

function parseDate(headers: string): Date | null {
  const m = /\[Date "([^"]+)"\]/.exec(headers);
  if (!m) return null;
  // ChessBase / pgnmentor PGNs use YYYY.MM.DD with `??` or `?` for unknown
  // month/day. Default unknowns to mid-year so partial-date games still
  // sort sensibly against complete dates.
  const parts = m[1]!.split('.');
  const y = parseInt(parts[0] ?? '', 10);
  if (!Number.isFinite(y) || y < 1900 || y > 2100) return null;
  const monthRaw = parts[1] ?? '';
  const dayRaw = parts[2] ?? '';
  const mm = /^\d+$/.test(monthRaw) ? parseInt(monthRaw, 10) : 6;
  const d = /^\d+$/.test(dayRaw) ? parseInt(dayRaw, 10) : 15;
  if (mm < 1 || mm > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mm - 1, d));
  return Number.isFinite(dt.getTime()) ? dt : null;
}

function main() {
  const text = readFileSync(INPUT, 'utf8');

  // Split on blank-line-then-[Event boundary. The first split position is
  // the start of game 1; we re-prepend the [Event line to each chunk.
  const chunks = text.split(/\n\s*\n(?=\[Event )/);
  console.log(`[sample] read ${text.length.toLocaleString()} bytes from ${INPUT}`);
  console.log(`[sample] split into ${chunks.length.toLocaleString()} game chunks`);

  const games: Array<{ text: string; date: Date | null; result: string | null }> = [];
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (trimmed.length === 0) continue;
    if (!TARGET_REGEX.test(trimmed)) continue;
    const date = parseDate(trimmed);
    const result = /\[Result "([^"]+)"\]/.exec(trimmed)?.[1] ?? null;
    games.push({ text: trimmed, date, result });
  }
  console.log(`[sample] ${games.length.toLocaleString()} games have Gelfand as a player`);

  // Sort by date descending; null dates go to the end.
  games.sort((a, b) => {
    if (a.date && b.date) return b.date.getTime() - a.date.getTime();
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });

  const sample = games.slice(0, SAMPLE_SIZE);
  console.log(`[sample] picking ${sample.length} most-recent games:`);
  for (const g of sample) {
    const evt = /\[Event "([^"]+)"\]/.exec(g.text)?.[1] ?? '(no event)';
    const dateStr = g.date ? g.date.toISOString().slice(0, 10) : '????-??-??';
    console.log(`  - ${dateStr}  ${g.result?.padEnd(8) ?? '???     '}  ${evt}`);
  }

  const out = sample.map((g) => g.text).join('\n\n');
  writeFileSync(OUTPUT, out, 'utf8');
  console.log(`[sample] wrote ${out.length.toLocaleString()} bytes to ${OUTPUT}`);
}

main();
