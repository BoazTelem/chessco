'use client';

/**
 * PositionEditor: board editor used in /practice/create.
 *
 * Drag-and-drop UX (Lichess-style):
 * - Drag a piece from the palette onto a board square to place it.
 * - Drag a board piece off the board to remove it.
 * - Drag piece-to-piece within the board to move it (overwrites destination).
 * - Right-click any square to clear it (keyboard-free quick delete).
 *
 * Side-to-move, castling rights, and en-passant square are controlled via
 * the side panel. A FEN textarea lets you paste a position; blur applies it.
 *
 * Emits onChange(fen, ok, reason?) on every edit.
 */

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Piece, Square } from 'react-chessboard/dist/chessboard/types';
// Note on drag UX: we deliberately do NOT mutate `boardMap` in onPieceDragBegin.
// Doing so re-renders the Chessboard with the source square empty, which
// unmounts the source <Piece/> mid-drag and takes react-dnd's drag preview
// with it. The piece appears to vanish while the user is still dragging
// (Lichess-style snap-free remove is implemented via onPieceDropOffBoard
// instead, which fires only after the user releases off the board).
import { validateFen, STANDARD_START_FEN } from '@/lib/practice/fen';
import { BOARD_BORDER, BOARD_DARK_SQUARE, BOARD_LIGHT_SQUARE } from '../prepare/board-theme';

const Chessboard = dynamic(() => import('react-chessboard').then((m) => m.Chessboard), {
  ssr: false,
  loading: () => (
    <div
      className="aspect-square w-full rounded-md border bg-muted/30"
      style={{ borderColor: BOARD_BORDER }}
    />
  ),
});
const ChessboardDnDProvider = dynamic(
  () => import('react-chessboard').then((m) => m.ChessboardDnDProvider),
  { ssr: false },
);
const SparePiece = dynamic(() => import('react-chessboard').then((m) => m.SparePiece), {
  ssr: false,
});

const EMPTY_FEN = '8/8/8/8/8/8/8/8 w - - 0 1';
const BOARD_ID = 'practice-editor';

const PIECE_TO_FEN: Record<string, string> = {
  wP: 'P',
  wN: 'N',
  wB: 'B',
  wR: 'R',
  wQ: 'Q',
  wK: 'K',
  bP: 'p',
  bN: 'n',
  bB: 'b',
  bR: 'r',
  bQ: 'q',
  bK: 'k',
};
const FEN_TO_PIECE: Record<string, string> = Object.fromEntries(
  Object.entries(PIECE_TO_FEN).map(([k, v]) => [v, k]),
);

function fenToBoardMap(fen: string): Record<string, string> {
  const boardPart = fen.split(' ')[0] ?? '';
  const ranks = boardPart.split('/');
  const out: Record<string, string> = {};
  for (let r = 0; r < 8; r++) {
    const rank = 8 - r;
    let file = 0;
    const rankStr = ranks[r] ?? '';
    for (const ch of rankStr) {
      if (/\d/.test(ch)) {
        file += Number(ch);
      } else {
        const square = `${'abcdefgh'[file]}${rank}`;
        const piece = FEN_TO_PIECE[ch];
        if (piece) out[square] = piece;
        file++;
      }
    }
  }
  return out;
}

function boardMapToFenBoard(map: Record<string, string>): string {
  const ranks: string[] = [];
  for (let rank = 8; rank >= 1; rank--) {
    let row = '';
    let empties = 0;
    for (const file of 'abcdefgh') {
      const sq = `${file}${rank}`;
      const piece = map[sq];
      if (!piece) {
        empties++;
      } else {
        if (empties > 0) {
          row += String(empties);
          empties = 0;
        }
        row += PIECE_TO_FEN[piece];
      }
    }
    if (empties > 0) row += String(empties);
    ranks.push(row);
  }
  return ranks.join('/');
}

interface Props {
  initialFen?: string;
  onChange?: (fen: string, ok: boolean, reason?: string) => void;
}

const PALETTE: Array<{ piece: string; label: string }> = [
  { piece: 'wK', label: 'White King' },
  { piece: 'wQ', label: 'White Queen' },
  { piece: 'wR', label: 'White Rook' },
  { piece: 'wB', label: 'White Bishop' },
  { piece: 'wN', label: 'White Knight' },
  { piece: 'wP', label: 'White Pawn' },
  { piece: 'bK', label: 'Black King' },
  { piece: 'bQ', label: 'Black Queen' },
  { piece: 'bR', label: 'Black Rook' },
  { piece: 'bB', label: 'Black Bishop' },
  { piece: 'bN', label: 'Black Knight' },
  { piece: 'bP', label: 'Black Pawn' },
];

const MAX_BOARD = 520;
const MIN_BOARD = 260;
const SPARE_PIECE_WIDTH = 36;

export function PositionEditor({ initialFen = STANDARD_START_FEN, onChange }: Props) {
  const [boardMap, setBoardMap] = useState<Record<string, string>>(() => fenToBoardMap(initialFen));
  const [sideToMove, setSideToMove] = useState<'w' | 'b'>(
    () => (initialFen.split(' ')[1] ?? 'w') as 'w' | 'b',
  );
  const [whiteOO, setWhiteOO] = useState(() => (initialFen.split(' ')[2] ?? '').includes('K'));
  const [whiteOOO, setWhiteOOO] = useState(() => (initialFen.split(' ')[2] ?? '').includes('Q'));
  const [blackOO, setBlackOO] = useState(() => (initialFen.split(' ')[2] ?? '').includes('k'));
  const [blackOOO, setBlackOOO] = useState(() => (initialFen.split(' ')[2] ?? '').includes('q'));
  const [epSquare, setEpSquare] = useState<string>(() => initialFen.split(' ')[3] ?? '-');
  const [fenInput, setFenInput] = useState(initialFen);
  const [orientation, setOrientation] = useState<'white' | 'black'>('white');
  const [boardWidth, setBoardWidth] = useState(MAX_BOARD);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = entry.contentRect.width;
      setBoardWidth(Math.max(MIN_BOARD, Math.min(MAX_BOARD, Math.floor(w))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const composedFen = useMemo(() => {
    const board = boardMapToFenBoard(boardMap);
    const castling =
      [whiteOO && 'K', whiteOOO && 'Q', blackOO && 'k', blackOOO && 'q'].filter(Boolean).join('') ||
      '-';
    const ep = /^[a-h][36]$/.test(epSquare) ? epSquare : '-';
    return `${board} ${sideToMove} ${castling} ${ep} 0 1`;
  }, [boardMap, sideToMove, whiteOO, whiteOOO, blackOO, blackOOO, epSquare]);

  useEffect(() => {
    const v = validateFen(composedFen);
    if (v.ok) {
      setError(null);
      setFenInput(v.fen);
      onChange?.(v.fen, true);
    } else {
      setError(v.reason);
      setFenInput(composedFen);
      onChange?.(composedFen, false, v.reason);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composedFen]);

  // Palette-to-board: add at target.
  const handleSparePieceDrop = useCallback((piece: Piece, targetSquare: Square): boolean => {
    setBoardMap((m) => ({ ...m, [targetSquare]: piece }));
    return true;
  }, []);

  // Board-to-board drop. Moves the piece (overwriting any occupant). Same-
  // square drops are a no-op but we still update the map (setBoardMap is
  // idempotent in that case).
  const handlePieceDrop = useCallback(
    (sourceSquare: Square, targetSquare: Square, piece: Piece): boolean => {
      if (sourceSquare === targetSquare) return false;
      setBoardMap((m) => {
        const next = { ...m };
        delete next[sourceSquare];
        next[targetSquare] = piece;
        return next;
      });
      return true;
    },
    [],
  );

  // Drag off the board → remove from boardMap. react-chessboard fires this
  // only after the user releases outside any droppable square, so the source
  // <Piece/> stays mounted for the entire drag and the preview never vanishes
  // mid-drag.
  const handlePieceDropOffBoard = useCallback((sourceSquare: Square) => {
    if (!/^[a-h][1-8]$/.test(sourceSquare)) return;
    setBoardMap((m) => {
      const next = { ...m };
      delete next[sourceSquare];
      return next;
    });
  }, []);

  const handleSquareRightClick = useCallback((square: Square) => {
    setBoardMap((m) => {
      const next = { ...m };
      delete next[square];
      return next;
    });
  }, []);

  function loadFen(raw: string) {
    const v = validateFen(raw);
    if (!v.ok) {
      try {
        setBoardMap(fenToBoardMap(raw));
      } catch {
        /* ignore */
      }
      setError(v.reason);
      return;
    }
    const parts = v.fen.split(' ');
    setBoardMap(fenToBoardMap(v.fen));
    setSideToMove((parts[1] ?? 'w') as 'w' | 'b');
    setWhiteOO((parts[2] ?? '').includes('K'));
    setWhiteOOO((parts[2] ?? '').includes('Q'));
    setBlackOO((parts[2] ?? '').includes('k'));
    setBlackOOO((parts[2] ?? '').includes('q'));
    setEpSquare(parts[3] ?? '-');
  }

  return (
    <ChessboardDnDProvider>
      <div className="grid gap-4 md:grid-cols-[1fr_auto]">
        <div ref={containerRef} className="mx-auto w-full" style={{ maxWidth: `${MAX_BOARD}px` }}>
          <div
            className="overflow-hidden rounded-md"
            style={{ border: `2px solid ${BOARD_BORDER}` }}
          >
            <Chessboard
              id={BOARD_ID}
              position={composedFen.split(' ')[0]}
              boardWidth={boardWidth}
              boardOrientation={orientation}
              customDarkSquareStyle={{ backgroundColor: BOARD_DARK_SQUARE }}
              customLightSquareStyle={{ backgroundColor: BOARD_LIGHT_SQUARE }}
              arePiecesDraggable={true}
              onPieceDrop={handlePieceDrop}
              onSparePieceDrop={handleSparePieceDrop}
              onPieceDropOffBoard={handlePieceDropOffBoard}
              onSquareRightClick={handleSquareRightClick}
            />
          </div>
          <p className="mt-2 text-center text-[11px] text-muted-foreground">
            Drag pieces from the palette →. Drag a piece off the board to remove it. Right-click to
            clear a square.
          </p>
        </div>

        <aside className="space-y-4 md:w-64">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Pieces
            </p>
            <div className="grid grid-cols-6 gap-1 rounded-md border border-border bg-card p-2">
              {PALETTE.map((p) => (
                <div
                  key={p.piece}
                  title={p.label}
                  className="flex aspect-square items-center justify-center rounded bg-background"
                >
                  <SparePiece piece={p.piece as Piece} width={SPARE_PIECE_WIDTH} dndId={BOARD_ID} />
                </div>
              ))}
            </div>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => loadFen(STANDARD_START_FEN)}
              className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs hover:bg-muted"
            >
              Start position
            </button>
            <button
              type="button"
              onClick={() => loadFen(EMPTY_FEN)}
              className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs hover:bg-muted"
            >
              Clear board
            </button>
            <button
              type="button"
              onClick={() => setOrientation((o) => (o === 'white' ? 'black' : 'white'))}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-xs hover:bg-muted"
            >
              Flip
            </button>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Side to move
            </p>
            <div className="flex gap-1 rounded-md border border-border bg-card p-1">
              {(['w', 'b'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSideToMove(s)}
                  className={`flex-1 rounded px-2 py-1 text-xs ${
                    sideToMove === s ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'
                  }`}
                >
                  {s === 'w' ? 'White' : 'Black'}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Castling rights
            </p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={whiteOO}
                  onChange={(e) => setWhiteOO(e.target.checked)}
                />
                White O-O
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={whiteOOO}
                  onChange={(e) => setWhiteOOO(e.target.checked)}
                />
                White O-O-O
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={blackOO}
                  onChange={(e) => setBlackOO(e.target.checked)}
                />
                Black O-O
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={blackOOO}
                  onChange={(e) => setBlackOOO(e.target.checked)}
                />
                Black O-O-O
              </label>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              En passant square
            </label>
            <input
              type="text"
              value={epSquare}
              onChange={(e) => setEpSquare(e.target.value.trim().toLowerCase())}
              placeholder="-"
              maxLength={2}
              className="w-20 rounded-md border border-border bg-background px-2 py-1 text-xs"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              FEN
            </label>
            <textarea
              value={fenInput}
              onChange={(e) => setFenInput(e.target.value)}
              onBlur={() => loadFen(fenInput)}
              rows={3}
              className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-xs"
            />
            <p className="mt-1 text-[10px] text-muted-foreground">Paste a FEN, blur to apply.</p>
          </div>

          {error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-xs text-destructive">
              {error}
            </p>
          )}
        </aside>
      </div>
    </ChessboardDnDProvider>
  );
}
