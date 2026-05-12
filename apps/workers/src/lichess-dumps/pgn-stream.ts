/**
 * Streaming PGN parser for Lichess monthly dumps.
 *
 * Lichess dump format (after zstd decompression):
 *   [Event "..."]
 *   [Site "..."]
 *   ...
 *   [SomeTag "..."]
 *
 *   1. e4 { [%eval 0.0] [%clk 0:05:00] } e5 ... 1-0
 *
 *   [Event "..."]   <- next game starts
 *   ...
 *
 * Games are separated by a blank line between the moveline and the next
 * header block. We do NOT load the whole file — we yield one game at a
 * time as we read.
 */
import type { Readable } from 'node:stream';
import type { ParsedGame, PgnHeaders } from './types';

const HEADER_RE = /^\[([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\]$/;

/** Async generator: yields one ParsedGame per game in the stream. */
export async function* streamGames(input: Readable): AsyncGenerator<ParsedGame> {
  let buffer = '';
  let byteOffset = 0;
  let inHeaders = false;
  let headers: PgnHeaders = {};
  let moveLines: string[] = [];
  let gameStartOffset = 0;

  // Process one logical line at a time.
  for await (const chunk of input) {
    const chunkStr = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    buffer += chunkStr;
    byteOffset += Buffer.byteLength(chunkStr, 'utf8');

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
      const rawLine = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

      if (line.startsWith('[')) {
        if (!inHeaders) {
          // Starting a new game's header block.
          inHeaders = true;
          headers = {};
          moveLines = [];
          gameStartOffset = byteOffset - buffer.length - rawLine.length - 1;
        }
        const m = HEADER_RE.exec(line);
        if (m) {
          headers[m[1]!] = unescapePgnQuoted(m[2]!);
        }
        continue;
      }

      if (line === '') {
        // Blank line: end of headers (if we just finished header block) OR
        // end of moves block (if we just finished moves).
        if (inHeaders && moveLines.length === 0) {
          // Transitioning from headers → moves. No game to yield yet.
          inHeaders = false;
          continue;
        }
        if (moveLines.length > 0) {
          // End of moves block → game complete.
          yield {
            headers,
            moveText: moveLines.join(' ').trim(),
            byteOffset: gameStartOffset,
          };
          headers = {};
          moveLines = [];
          inHeaders = false;
        }
        continue;
      }

      // Non-empty, not header → it's part of the moves block.
      moveLines.push(line);
      inHeaders = false;
    }
  }

  // Tail flush — handle a final game without trailing blank line.
  if (moveLines.length > 0 && Object.keys(headers).length > 0) {
    yield {
      headers,
      moveText: moveLines.join(' ').trim(),
      byteOffset: gameStartOffset,
    };
  }
}

/** PGN tag values escape `"` and `\`. Undo those. */
function unescapePgnQuoted(s: string): string {
  return s.replace(/\\(["\\])/g, '$1');
}
