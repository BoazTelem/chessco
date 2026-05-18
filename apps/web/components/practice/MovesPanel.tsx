'use client';

/**
 * MovesPanel: paired white/black columns of SAN moves for the live game
 * sidebar. Parses the live PGN client-side so we never show chess.js's
 * default seven-tag-roster (`[Date "????.??.??"]` etc.) which makes the
 * sidebar look broken. Auto-scrolls so the latest move is always visible.
 *
 * Piece moves are rendered with a Unicode chess glyph in place of the SAN
 * piece letter (Lichess / chess.com convention). The file-of-disambiguation
 * or capture marker stays as text right after the glyph.
 */

import { useEffect, useRef } from 'react';
import { parsePgnToMoves } from '@/lib/practice/parse-pgn';
import { splitSan } from '@/lib/practice/san-glyph';

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

  const rows: Array<{ num: number; white: string | null; black: string | null }> = [];
  for (let i = 0; i < moves.length; i += 2) {
    rows.push({
      num: Math.floor(i / 2) + 1,
      white: moves[i]?.san ?? null,
      black: moves[i + 1]?.san ?? null,
    });
  }

  const lastPly = moves.length - 1;

  if (moves.length === 0) {
    return <p className="px-1 py-2 text-xs text-muted-foreground">No moves yet.</p>;
  }

  return (
    <div ref={scrollRef} className="max-h-[60vh] min-h-[12rem] overflow-auto pr-1">
      <ol className="space-y-0.5 text-sm">
        {rows.map((r, i) => {
          const whitePly = i * 2;
          const blackPly = i * 2 + 1;
          return (
            <li key={r.num} className="grid grid-cols-[1.75rem_1fr_1fr] items-center gap-1 py-0.5">
              <span className="text-xs tabular-nums text-muted-foreground">{r.num}.</span>
              <MoveCell san={r.white} highlighted={whitePly === lastPly} />
              <MoveCell san={r.black} highlighted={blackPly === lastPly} />
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function MoveCell({ san, highlighted }: { san: string | null; highlighted: boolean }) {
  if (!san) return <span />;
  const { glyph, rest } = splitSan(san);
  return (
    <span
      className={`inline-flex items-baseline gap-0.5 rounded px-1 ${
        highlighted ? 'bg-accent/25 font-semibold' : ''
      }`}
    >
      {glyph && <span className="text-base leading-none">{glyph}</span>}
      <span className="font-mono tabular-nums">{rest}</span>
    </span>
  );
}
