'use client';

/**
 * MovesPanel — paired white/black columns of SAN moves for the live game
 * sidebar. Parses the live PGN client-side so we never show chess.js's
 * default seven-tag-roster (`[Date "????.??.??"]` etc.) which makes the
 * sidebar look broken. Auto-scrolls so the latest move is always visible.
 */

import { useEffect, useRef } from 'react';
import { parsePgnToMoves } from '@/lib/practice/parse-pgn';

interface Props {
  pgn: string;
  initialFen: string;
}

export function MovesPanel({ pgn, initialFen }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const moves = parsePgnToMoves(pgn, initialFen);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [moves.length]);

  // Pair plies into rows: [[white, black], [white, black], ...]
  const rows: Array<{ num: number; white: string | null; black: string | null }> = [];
  for (let i = 0; i < moves.length; i += 2) {
    rows.push({
      num: Math.floor(i / 2) + 1,
      white: moves[i]?.san ?? null,
      black: moves[i + 1]?.san ?? null,
    });
  }

  const lastPly = moves.length - 1; // 0-indexed; -1 = none

  if (moves.length === 0) {
    return <p className="px-1 py-2 text-xs text-muted-foreground">No moves yet.</p>;
  }

  return (
    <div ref={scrollRef} className="max-h-[60vh] min-h-[12rem] overflow-auto pr-1">
      <ol className="space-y-0.5 text-sm font-mono">
        {rows.map((r, i) => {
          const whitePly = i * 2;
          const blackPly = i * 2 + 1;
          return (
            <li key={r.num} className="grid grid-cols-[2rem_1fr_1fr] gap-1">
              <span className="text-xs text-muted-foreground">{r.num}.</span>
              <span
                className={`rounded px-1 ${
                  whitePly === lastPly ? 'bg-accent/25 font-semibold' : ''
                }`}
              >
                {r.white ?? ''}
              </span>
              <span
                className={`rounded px-1 ${
                  blackPly === lastPly ? 'bg-accent/25 font-semibold' : ''
                }`}
              >
                {r.black ?? ''}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
