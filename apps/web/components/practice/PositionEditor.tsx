'use client';

/**
 * PositionEditor — board editor used in /practice/create.
 *
 * Primary UX: click a piece in the palette to "pick it up", then click an
 * empty square on the board to place it. Click a square that already has the
 * same piece to remove it. Right-click any square to clear it. You can also
 * drag pieces *within* the board to move them.
 *
 * Side-to-move, castling, en-passant are controlled via dedicated inputs.
 * A FEN textarea lets you paste a position; blur applies it.
 *
 * Emits onChange(fen, ok, reason?) on every successful or attempted edit.
 */

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Piece, Square } from 'react-chessboard/dist/chessboard/types';
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

const EMPTY_FEN = '8/8/8/8/8/8/8/8 w - - 0 1';

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

const PALETTE: Array<{ piece: string; glyph: string; label: string }> = [
  { piece: 'wK', glyph: '♔', label: 'White King' },
  { piece: 'wQ', glyph: '♕', label: 'White Queen' },
  { piece: 'wR', glyph: '♖', label: 'White Rook' },
  { piece: 'wB', glyph: '♗', label: 'White Bishop' },
  { piece: 'wN', glyph: '♘', label: 'White Knight' },
  { piece: 'wP', glyph: '♙', label: 'White Pawn' },
  { piece: 'bK', glyph: '♚', label: 'Black King' },
  { piece: 'bQ', glyph: '♛', label: 'Black Queen' },
  { piece: 'bR', glyph: '♜', label: 'Black Rook' },
  { piece: 'bB', glyph: '♝', label: 'Black Bishop' },
  { piece: 'bN', glyph: '♞', label: 'Black Knight' },
  { piece: 'bP', glyph: '♟', label: 'Black Pawn' },
];

const MAX_BOARD = 520;
const MIN_BOARD = 260;

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
  const [selectedPiece, setSelectedPiece] = useState<string | null>(null);
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

  const handleSquareClick = useCallback(
    (square: Square) => {
      if (!selectedPiece) {
        // Tap an occupied square to "pick up" that piece for re-placement.
        const existing = boardMap[square];
        if (existing) {
          setSelectedPiece(existing);
          setBoardMap((m) => {
            const next = { ...m };
            delete next[square];
            return next;
          });
        }
        return;
      }
      // Place the selected piece. Click again on same piece to clear that square.
      setBoardMap((m) => {
        const next = { ...m };
        if (next[square] === selectedPiece) {
          delete next[square];
        } else {
          next[square] = selectedPiece;
        }
        return next;
      });
    },
    [boardMap, selectedPiece],
  );

  const handleSquareRightClick = useCallback((square: Square) => {
    setBoardMap((m) => {
      const next = { ...m };
      delete next[square];
      return next;
    });
  }, []);

  // Drag within board: move piece from source to target. (react-chessboard v4
  // signature is (source, target, piece) => boolean.)
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

  const cursorClass = selectedPiece ? 'cursor-copy' : 'cursor-default';

  return (
    <div className="grid gap-4 md:grid-cols-[1fr_auto]">
      <div
        ref={containerRef}
        className={`mx-auto w-full ${cursorClass}`}
        style={{ maxWidth: `${MAX_BOARD}px` }}
      >
        <div className="overflow-hidden rounded-md" style={{ border: `2px solid ${BOARD_BORDER}` }}>
          <Chessboard
            position={composedFen.split(' ')[0]}
            boardWidth={boardWidth}
            boardOrientation={orientation}
            customDarkSquareStyle={{ backgroundColor: BOARD_DARK_SQUARE }}
            customLightSquareStyle={{ backgroundColor: BOARD_LIGHT_SQUARE }}
            arePiecesDraggable={!selectedPiece}
            onPieceDrop={handlePieceDrop}
            onSquareClick={handleSquareClick}
            onSquareRightClick={handleSquareRightClick}
          />
        </div>
        <p className="mt-2 text-center text-[11px] text-muted-foreground">
          {selectedPiece
            ? 'Click any square to place the selected piece. Click the palette piece again to deselect.'
            : 'Click a palette piece → click a square. Drag to move. Right-click to clear.'}
        </p>
      </div>

      <aside className="space-y-4 md:w-64">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Pieces
          </p>
          <div className="grid grid-cols-6 gap-1 rounded-md border border-border bg-card p-2">
            {PALETTE.map((p) => (
              <button
                key={p.piece}
                type="button"
                title={p.label}
                onClick={() => setSelectedPiece((cur) => (cur === p.piece ? null : p.piece))}
                className={`flex aspect-square items-center justify-center rounded text-2xl ${
                  selectedPiece === p.piece
                    ? 'bg-accent text-accent-foreground ring-2 ring-accent'
                    : 'bg-background hover:bg-muted'
                }`}
              >
                <span aria-hidden="true">{p.glyph}</span>
              </button>
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
  );
}
