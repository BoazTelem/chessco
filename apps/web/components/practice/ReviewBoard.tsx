'use client';

/**
 * ReviewBoard: post-game analysis. Loads the final PGN from the parent
 * (server-fetched live_games.pgn), steps through every ply, and runs each
 * resulting position through a client-side Stockfish web worker. Annotates
 * moves with inaccuracy/mistake/blunder based on centipawn loss vs the
 * engine's top choice.
 */

import dynamic from 'next/dynamic';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  annotateCpLoss,
  StockfishEngine,
  type Annotation,
  type EvalResult,
} from '@/lib/practice/engine';
import { parsePgnToMoves } from '@/lib/practice/parse-pgn';
import { EvalBar } from './EvalBar';
import {
  BOARD_BORDER,
  BOARD_DARK_SQUARE,
  BOARD_LIGHT_SQUARE,
  BOARD_LAST_MOVE_TINT,
} from '../prepare/board-theme';

const EVAL_BAR_PREF_KEY = 'practice.evalBar.visible';

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
// Responsive board sizing mirrors GamePlayer so the post-game board doesn't
// shrink versus the live game. Tuned for the review layout's right-hand
// 360px sidebar and extra eval-after card below the board.
const SIDEBAR_WIDTH = 360;
const VERTICAL_CHROME = 220;
const MIN_BOARD = 280;
const MAX_BOARD = 900;
const EVAL_BAR_SLOT = 32; // 24px bar + 8px gap

function computeBoardSize(evalBarOn: boolean): number {
  if (typeof window === 'undefined') return 560;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const sidebar = vw >= 1024 ? SIDEBAR_WIDTH + 32 : 0;
  const evalSlot = evalBarOn ? EVAL_BAR_SLOT : 0;
  const widthCap = vw - sidebar - evalSlot - 32;
  const heightCap = vh - VERTICAL_CHROME;
  return Math.max(MIN_BOARD, Math.min(MAX_BOARD, Math.floor(Math.min(widthCap, heightCap))));
}

export function ReviewBoard({ pgn, initialFen, whiteName, blackName }: Props) {
  const [moves, setMoves] = useState<MoveEntry[]>(() =>
    parsePgnToMoves(pgn, initialFen).map((p) => ({
      ...p,
      evalBefore: null,
      evalAfter: null,
      cpLoss: null,
      annotation: null,
    })),
  );
  const [idx, setIdx] = useState(moves.length - 1);
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [evalBarVisible, setEvalBarVisible] = useState(true);
  const [boardWidth, setBoardWidth] = useState(() => computeBoardSize(true));
  const engineRef = useRef<StockfishEngine | null>(null);

  // Restore persisted eval-bar preference. Default on; only an explicit '0'
  // turns it off, so users who already toggled it off keep that choice.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const v = window.localStorage.getItem(EVAL_BAR_PREF_KEY);
      setEvalBarVisible(v === null ? true : v === '1');
    } catch {
      /* ignore */
    }
  }, []);

  // Responsively size the board against the viewport and recompute whenever
  // the eval bar visibility changes (it claims a 32px horizontal slot).
  useEffect(() => {
    function update() {
      setBoardWidth(computeBoardSize(evalBarVisible));
    }
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [evalBarVisible]);

  function toggleEvalBar(): void {
    setEvalBarVisible((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(EVAL_BAR_PREF_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  // Keyboard arrow navigation through moves. Skip while focus is in a text
  // input so users can still type freely.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setIdx((i) => Math.max(-1, i - 1));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setIdx((i) => Math.min(moves.length - 1, i + 1));
      } else if (e.key === 'Home') {
        e.preventDefault();
        setIdx(-1);
      } else if (e.key === 'End') {
        e.preventDefault();
        setIdx(moves.length - 1);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [moves.length]);

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

  // Eval shown next to the bar always reflects the currently-displayed
  // position (after the selected move, or pre-game when idx === -1).
  const shownEval: EvalResult | null = current?.evalAfter ?? null;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div
        className="mx-auto w-full"
        style={{ maxWidth: boardWidth + (evalBarVisible ? EVAL_BAR_SLOT : 0) }}
      >
        <div className="flex gap-2">
          {evalBarVisible && (
            <EvalBar cp={shownEval?.cp} mate={shownEval?.mate} heightPx={boardWidth} />
          )}
          <div
            className="overflow-hidden rounded-md"
            style={{ border: `2px solid ${BOARD_BORDER}` }}
          >
            <Chessboard
              position={currentFen}
              boardWidth={boardWidth}
              customDarkSquareStyle={{ backgroundColor: BOARD_DARK_SQUARE }}
              customLightSquareStyle={{ backgroundColor: BOARD_LIGHT_SQUARE }}
              customSquareStyles={squareStyles}
              arePiecesDraggable={false}
            />
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between gap-2">
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
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={toggleEvalBar}
              className={`rounded-md border px-2.5 py-1 text-xs ${
                evalBarVisible
                  ? 'border-accent bg-accent text-accent-foreground'
                  : 'border-border bg-background hover:bg-muted'
              }`}
              title="Use ← → keys to step through moves"
            >
              Eval bar: {evalBarVisible ? 'On' : 'Off'}
            </button>
            <p className="text-xs text-muted-foreground">
              {analyzing ? `Analyzing… ${Math.round(progress)}%` : 'Analysis complete'}
            </p>
          </div>
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
                {current.evalAfter ? formatEval(current.evalAfter) : '-'}
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
                  i === idx ? 'bg-accent font-semibold text-accent-foreground' : 'hover:bg-muted'
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
  if (e.cp === null) return '-';
  const pawns = (e.cp / 100).toFixed(2);
  return e.cp >= 0 ? `+${pawns}` : pawns;
}
function scoreToCp(e: EvalResult): number {
  if (e.mate !== null) return e.mate > 0 ? 10_000 : -10_000;
  return e.cp ?? 0;
}
