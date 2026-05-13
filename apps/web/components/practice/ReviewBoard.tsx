'use client';

/**
 * ReviewBoard — post-game analysis. Loads the final PGN from the parent
 * (server-fetched live_games.pgn), steps through every ply, and runs each
 * resulting position through a client-side Stockfish web worker. Annotates
 * moves with inaccuracy/mistake/blunder based on centipawn loss vs the
 * engine's top choice.
 */

import dynamic from 'next/dynamic';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import {
  annotateCpLoss,
  StockfishEngine,
  type Annotation,
  type EvalResult,
} from '@/lib/practice/engine';
import {
  BOARD_BORDER,
  BOARD_DARK_SQUARE,
  BOARD_LIGHT_SQUARE,
  BOARD_LAST_MOVE_TINT,
} from '../prepare/board-theme';

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
  pgn: string;
  initialFen: string;
  whiteName: string;
  blackName: string;
}

interface MoveEntry {
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  evalBefore: EvalResult | null;
  evalAfter: EvalResult | null;
  cpLoss: number | null;
  annotation: Annotation | null;
}

const DEPTH = 16;
const MAX_BOARD = 520;

export function ReviewBoard({ pgn, initialFen, whiteName, blackName }: Props) {
  const [moves, setMoves] = useState<MoveEntry[]>(() => parsePgnToMoves(pgn, initialFen));
  const [idx, setIdx] = useState(moves.length - 1);
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);
  const engineRef = useRef<StockfishEngine | null>(null);

  // Auto-run a full pass on mount.
  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (moves.length === 0) return;
      setAnalyzing(true);
      const engine = new StockfishEngine();
      engineRef.current = engine;
      await engine.whenReady();
      const updated = [...moves];
      for (let i = 0; i < updated.length; i++) {
        if (cancelled) break;
        const m = updated[i]!;
        const before = await engine.evaluate(m.fenBefore, DEPTH);
        if (cancelled) break;
        const after = await engine.evaluate(m.fenAfter, DEPTH);
        if (cancelled) break;
        // CP loss relative to the side that just moved.
        const beforeCp = scoreToCp(before);
        const afterCp = scoreToCp(after);
        const moverIsWhite = m.fenBefore.split(' ')[1] === 'w';
        const loss = moverIsWhite ? beforeCp - afterCp : afterCp - beforeCp;
        const ann = annotateCpLoss(loss);
        updated[i] = { ...m, evalBefore: before, evalAfter: after, cpLoss: loss, annotation: ann };
        setMoves([...updated]);
        setProgress(((i + 1) / updated.length) * 100);
      }
      setAnalyzing(false);
    }
    void run();
    return () => {
      cancelled = true;
      engineRef.current?.stop();
      engineRef.current = null;
    };
    // We deliberately don't rerun on `moves` changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = idx >= 0 && idx < moves.length ? moves[idx] : null;
  const currentFen = current?.fenAfter ?? initialFen;
  const lastUci = current?.uci;

  const squareStyles = useMemo<Record<string, React.CSSProperties>>(() => {
    if (!lastUci) return {};
    const from = lastUci.slice(0, 2);
    const to = lastUci.slice(2, 4);
    return {
      [from]: { background: BOARD_LAST_MOVE_TINT },
      [to]: { background: BOARD_LAST_MOVE_TINT },
    };
  }, [lastUci]);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div className="mx-auto w-full" style={{ maxWidth: `${MAX_BOARD}px` }}>
        <div className="overflow-hidden rounded-md" style={{ border: `2px solid ${BOARD_BORDER}` }}>
          <Chessboard
            position={currentFen}
            boardWidth={MAX_BOARD}
            customDarkSquareStyle={{ backgroundColor: BOARD_DARK_SQUARE }}
            customLightSquareStyle={{ backgroundColor: BOARD_LIGHT_SQUARE }}
            customSquareStyles={squareStyles}
            arePiecesDraggable={false}
          />
        </div>

        <div className="mt-3 flex items-center justify-between">
          <div className="flex gap-1">
            <NavBtn onClick={() => setIdx(-1)} label="«" disabled={idx < 0} />
            <NavBtn
              onClick={() => setIdx((i) => Math.max(-1, i - 1))}
              label="‹"
              disabled={idx < 0}
            />
            <NavBtn
              onClick={() => setIdx((i) => Math.min(moves.length - 1, i + 1))}
              label="›"
              disabled={idx >= moves.length - 1}
            />
            <NavBtn
              onClick={() => setIdx(moves.length - 1)}
              label="»"
              disabled={idx >= moves.length - 1}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {analyzing ? `Analyzing… ${Math.round(progress)}%` : 'Analysis complete'}
          </p>
        </div>

        {current && (
          <div className="mt-3 rounded-lg border border-border bg-card p-3">
            <p className="text-xs text-muted-foreground">
              Move {Math.floor(idx / 2) + 1}
              {idx % 2 === 0 ? '.' : '...'} {current.san}
            </p>
            <p className="mt-1 text-sm">
              Eval after:{' '}
              <span className="font-mono">
                {current.evalAfter ? formatEval(current.evalAfter) : '—'}
              </span>
              {current.annotation &&
                current.annotation !== 'best' &&
                current.annotation !== 'good' && (
                  <span
                    className={`ml-2 text-xs font-semibold ${annotationColor(current.annotation)}`}
                  >
                    {annotationLabel(current.annotation)}
                    {typeof current.cpLoss === 'number' &&
                      ` (−${Math.abs(Math.round(current.cpLoss))} cp)`}
                  </span>
                )}
            </p>
          </div>
        )}
      </div>

      <aside className="space-y-2">
        <div className="rounded-lg border border-border bg-card p-3 text-sm">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Players</p>
          <p>White: {whiteName}</p>
          <p>Black: {blackName}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <p className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">Moves</p>
          <ol className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            {moves.map((m, i) => (
              <li
                key={i}
                onClick={() => setIdx(i)}
                className={`cursor-pointer rounded px-1.5 py-0.5 ${
                  i === idx ? 'bg-accent/20 text-accent-foreground' : 'hover:bg-muted'
                }`}
              >
                <span className="mr-1 text-muted-foreground">
                  {i % 2 === 0 ? `${Math.floor(i / 2) + 1}.` : '…'}
                </span>
                {m.san}
                {m.annotation && m.annotation !== 'best' && m.annotation !== 'good' && (
                  <span className={`ml-1 ${annotationColor(m.annotation)}`}>
                    {annotationGlyph(m.annotation)}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      </aside>
    </div>
  );
}

function NavBtn({
  onClick,
  label,
  disabled,
}: {
  onClick: () => void;
  label: string;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border border-border bg-background px-2.5 py-1 text-sm disabled:opacity-40"
    >
      {label}
    </button>
  );
}

function annotationLabel(a: Annotation): string {
  switch (a) {
    case 'inaccuracy':
      return 'Inaccuracy';
    case 'mistake':
      return 'Mistake';
    case 'blunder':
      return 'Blunder';
    default:
      return '';
  }
}
function annotationGlyph(a: Annotation): string {
  switch (a) {
    case 'inaccuracy':
      return '?!';
    case 'mistake':
      return '?';
    case 'blunder':
      return '??';
    default:
      return '';
  }
}
function annotationColor(a: Annotation): string {
  switch (a) {
    case 'inaccuracy':
      return 'text-amber-600';
    case 'mistake':
      return 'text-orange-600';
    case 'blunder':
      return 'text-destructive';
    default:
      return '';
  }
}
function formatEval(e: EvalResult): string {
  if (e.mate !== null) return `M${e.mate}`;
  if (e.cp === null) return '—';
  const pawns = (e.cp / 100).toFixed(2);
  return e.cp >= 0 ? `+${pawns}` : pawns;
}
function scoreToCp(e: EvalResult): number {
  if (e.mate !== null) return e.mate > 0 ? 10_000 : -10_000;
  return e.cp ?? 0;
}

function parsePgnToMoves(pgn: string, initialFen: string): MoveEntry[] {
  if (!pgn?.trim()) return [];
  const chess = new Chess(initialFen);
  try {
    chess.loadPgn(pgn);
  } catch {
    return [];
  }
  const history = chess.history({ verbose: true });
  // Replay to capture fen before/after each move.
  const replay = new Chess(initialFen);
  const out: MoveEntry[] = [];
  for (const h of history) {
    const fenBefore = replay.fen();
    const m = replay.move({ from: h.from, to: h.to, promotion: h.promotion });
    if (!m) break;
    const uci = `${h.from}${h.to}${h.promotion ?? ''}`;
    out.push({
      san: h.san,
      uci,
      fenBefore,
      fenAfter: replay.fen(),
      evalBefore: null,
      evalAfter: null,
      cpLoss: null,
      annotation: null,
    });
  }
  return out;
}
