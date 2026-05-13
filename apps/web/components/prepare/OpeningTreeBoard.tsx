'use client';

import dynamic from 'next/dynamic';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Arrow, Square } from 'react-chessboard/dist/chessboard/types';
import type { NextMoveStats } from '@/lib/prepare/types';
import { performanceColor } from '@/lib/prepare/format';
import {
  BOARD_BORDER,
  BOARD_DARK_SQUARE,
  BOARD_LAST_MOVE_TINT,
  BOARD_LIGHT_SQUARE,
} from './board-theme';

const Chessboard = dynamic(() => import('react-chessboard').then((m) => m.Chessboard), {
  ssr: false,
  loading: () => (
    <div
      className="aspect-square w-full rounded-md border bg-muted/30"
      style={{ borderColor: BOARD_BORDER }}
    />
  ),
});

interface Props {
  fen: string;
  orientation: 'white' | 'black';
  topMoves: NextMoveStats[];
  hoveredMove: NextMoveStats | null;
  lastMove: { from: string; to: string } | null;
  onPickMove: (move: NextMoveStats) => void;
  onPieceDrop: (sourceSquare: string, targetSquare: string) => boolean;
}

function winRateOf(m: NextMoveStats): number {
  if (m.gamesCount === 0) return 0.5;
  return (m.wins + 0.5 * m.draws) / m.gamesCount;
}

const MAX_BOARD = 640;
const MIN_BOARD = 280;

export function OpeningTreeBoard({
  fen,
  orientation,
  topMoves,
  hoveredMove,
  lastMove,
  onPickMove,
  onPieceDrop,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [boardWidth, setBoardWidth] = useState(MAX_BOARD);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = entry.contentRect.width;
      const next = Math.max(MIN_BOARD, Math.min(MAX_BOARD, Math.floor(w)));
      setBoardWidth(next);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const top = topMoves.slice(0, 3);
  const maxWeighted = top[0]?.weightedScore ?? 0;

  const arrows = useMemo<Arrow[]>(() => {
    const out: Arrow[] = [];
    if (maxWeighted > 0) {
      top.forEach((m, idx) => {
        const ratio = m.weightedScore / maxWeighted;
        const alpha = idx === 0 ? 1 : Math.max(0.45, ratio);
        out.push([
          m.fromSquare as Square,
          m.toSquare as Square,
          performanceColor(winRateOf(m), alpha),
        ]);
      });
    }
    if (hoveredMove && !top.some((m) => m.uci === hoveredMove.uci)) {
      out.push([
        hoveredMove.fromSquare as Square,
        hoveredMove.toSquare as Square,
        performanceColor(winRateOf(hoveredMove), 0.9),
      ]);
    }
    return out;
  }, [top, maxWeighted, hoveredMove]);

  const squareStyles = useMemo<Record<string, React.CSSProperties>>(() => {
    const styles: Record<string, React.CSSProperties> = {};
    if (lastMove) {
      styles[lastMove.from] = { background: BOARD_LAST_MOVE_TINT };
      styles[lastMove.to] = { background: BOARD_LAST_MOVE_TINT };
    }
    if (hoveredMove) {
      styles[hoveredMove.fromSquare] = {
        ...(styles[hoveredMove.fromSquare] ?? {}),
        boxShadow: 'inset 0 0 0 3px hsla(35, 90%, 35%, 0.7)',
      };
      styles[hoveredMove.toSquare] = {
        ...(styles[hoveredMove.toSquare] ?? {}),
        boxShadow: 'inset 0 0 0 3px hsla(35, 90%, 35%, 0.7)',
      };
    }
    return styles;
  }, [lastMove, hoveredMove]);

  function handleSquareClick(square: Square) {
    const match = top.find((m) => m.toSquare === square);
    if (match) onPickMove(match);
  }

  function handlePieceDrop(sourceSquare: Square, targetSquare: Square): boolean {
    return onPieceDrop(sourceSquare, targetSquare);
  }

  return (
    <div ref={containerRef} className="mx-auto w-full" style={{ maxWidth: `${MAX_BOARD}px` }}>
      <div className="overflow-hidden rounded-md" style={{ border: `2px solid ${BOARD_BORDER}` }}>
        <Chessboard
          position={fen}
          boardWidth={boardWidth}
          boardOrientation={orientation}
          customDarkSquareStyle={{ backgroundColor: BOARD_DARK_SQUARE }}
          customLightSquareStyle={{ backgroundColor: BOARD_LIGHT_SQUARE }}
          customBoardStyle={{ background: BOARD_DARK_SQUARE }}
          customArrows={arrows}
          customSquareStyles={squareStyles}
          arePiecesDraggable={true}
          onSquareClick={handleSquareClick}
          onPieceDrop={handlePieceDrop}
        />
      </div>
    </div>
  );
}
