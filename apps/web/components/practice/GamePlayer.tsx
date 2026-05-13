'use client';

/**
 * GamePlayer — the live game UI. Connects to the realtime server via the
 * minted WS ticket, renders the board, drives moves, displays clocks with
 * local interpolation between server ticks, plays sounds, and shows the
 * game-end overlay with a link to the review.
 *
 * Reconnect strategy: on socket close before the game ends, re-fetch a
 * fresh ticket and try again with exponential backoff up to ~25 s. After
 * that the realtime server's grace timer will fire and the user will see
 * the "abandoned" state on next poll/refresh.
 */

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Piece, Square } from 'react-chessboard/dist/chessboard/types';
import type { ClientMsg, Color, Result, ServerMsg, Termination } from '@/lib/practice/protocol';
import { sounds } from '@/lib/practice/sounds';
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

interface Prefs {
  soundEnabled: boolean;
  premovesEnabled: boolean;
  showCoordinates: boolean;
  showLegalMoves: boolean;
  animationsEnabled: boolean;
}

interface Props {
  matchId: string;
  initialWsUrl: string;
  initialRole: Color;
  prefs: Prefs;
}

interface GameState {
  fen: string;
  pgn: string;
  whiteMs: number;
  blackMs: number;
  sideToMove: Color;
  lastMove: { uci: string; san: string } | null;
  status: 'live' | 'completed' | 'aborted' | 'abandoned';
  result: Result | null;
  termination: Termination | null;
}

const MAX_BOARD = 560;
const MIN_BOARD = 280;
const RECONNECT_DELAYS_MS = [500, 1500, 3000, 6000, 12000];

function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (ms < 10_000) {
    const tenths = Math.floor((ms % 1000) / 100);
    return `${m}:${String(s).padStart(2, '0')}.${tenths}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function GamePlayer({ matchId, initialWsUrl, initialRole, prefs }: Props) {
  const router = useRouter();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempt = useRef(0);
  const closedIntentionally = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [boardWidth, setBoardWidth] = useState(MAX_BOARD);
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<GameState | null>(null);
  const [role] = useState<Color>(initialRole);
  const [drawOfferedFrom, setDrawOfferedFrom] = useState<Color | null>(null);
  const [error, setError] = useState<string | null>(null);
  const localClock = useLocalClock(state);

  useEffect(() => {
    sounds.setEnabled(prefs.soundEnabled);
  }, [prefs.soundEnabled]);

  // Best-effort fairplay telemetry: tab focus/blur and paste detection.
  // Service-role insert via /api/practice/telemetry; no user-facing UI.
  useEffect(() => {
    function send(event: 'tab_blur' | 'tab_focus' | 'paste_detected') {
      void fetch('/api/practice/telemetry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ matchId, event, clientTs: Date.now() }),
        keepalive: true,
      }).catch(() => {});
    }
    function onVis() {
      send(document.hidden ? 'tab_blur' : 'tab_focus');
    }
    function onPaste() {
      send('paste_detected');
    }
    document.addEventListener('visibilitychange', onVis);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      document.removeEventListener('paste', onPaste);
    };
  }, [matchId]);

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

  // Connect (and reconnect) lifecycle.
  useEffect(() => {
    let currentUrl = initialWsUrl;
    let cancelled = false;

    function connect(url: string) {
      if (cancelled) return;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.addEventListener('open', () => {
        setConnected(true);
        reconnectAttempt.current = 0;
      });
      ws.addEventListener('message', (e) => onMessage(e.data));
      ws.addEventListener('close', () => {
        setConnected(false);
        wsRef.current = null;
        if (closedIntentionally.current) return;
        scheduleReconnect();
      });
      ws.addEventListener('error', () => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      });
    }

    async function scheduleReconnect() {
      const attempt = reconnectAttempt.current;
      const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 12000;
      reconnectAttempt.current = attempt + 1;
      await new Promise((r) => setTimeout(r, delay));
      if (cancelled) return;
      // Get a fresh ticket so we never present a stale one.
      try {
        const res = await fetch(`/api/practice/matches/${matchId}/ticket`, { method: 'POST' });
        if (!res.ok) {
          setError('Lost connection — the game may be over.');
          return;
        }
        const { url } = (await res.json()) as { url: string };
        currentUrl = url;
        connect(currentUrl);
      } catch {
        connect(currentUrl);
      }
    }

    connect(currentUrl);
    return () => {
      cancelled = true;
      closedIntentionally.current = true;
      try {
        wsRef.current?.close();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId, initialWsUrl]);

  const onMessage = useCallback((raw: string | ArrayBuffer | Blob) => {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as ServerMsg;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'state':
        setState({
          fen: msg.fen,
          pgn: msg.pgn,
          whiteMs: msg.whiteTimeMs,
          blackMs: msg.blackTimeMs,
          sideToMove: msg.sideToMove,
          lastMove: msg.lastMove ? { uci: msg.lastMove.uci, san: msg.lastMove.san } : null,
          status: msg.status,
          result: msg.result,
          termination: msg.termination,
        });
        return;
      case 'move':
        setState((s) =>
          s
            ? {
                ...s,
                fen: msg.fen,
                whiteMs: msg.whiteTimeMs,
                blackMs: msg.blackTimeMs,
                sideToMove: s.sideToMove === 'white' ? 'black' : 'white',
                lastMove: { uci: msg.uci, san: msg.san },
              }
            : s,
        );
        if (/x/.test(msg.san)) sounds.play('capture');
        else if (/\+|#/.test(msg.san)) sounds.play('check');
        else sounds.play('move');
        setDrawOfferedFrom(null);
        return;
      case 'clock':
        setState((s) => (s ? { ...s, whiteMs: msg.whiteTimeMs, blackMs: msg.blackTimeMs } : s));
        return;
      case 'end':
        setState((s) =>
          s
            ? {
                ...s,
                status: 'completed',
                result: msg.result,
                termination: msg.termination,
                whiteMs: msg.whiteTimeMs,
                blackMs: msg.blackTimeMs,
              }
            : s,
        );
        sounds.play('gameEnd');
        return;
      case 'draw_offer':
        setDrawOfferedFrom(msg.from);
        return;
      case 'draw_decline':
        setDrawOfferedFrom(null);
        return;
      case 'error':
        setError(msg.message);
        return;
    }
  }, []);

  const sendMsg = useCallback((m: ClientMsg) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== ws.OPEN) return false;
    try {
      ws.send(JSON.stringify(m));
      return true;
    } catch {
      return false;
    }
  }, []);

  const onPieceDrop = useCallback(
    (sourceSquare: Square, targetSquare: Square, piece: Piece): boolean => {
      if (!state || state.status !== 'live') return false;
      if (state.sideToMove !== role) return false;
      const promotion =
        piece.endsWith('Q') || piece.endsWith('R') || piece.endsWith('B') || piece.endsWith('N')
          ? piece[1]!.toLowerCase()
          : undefined;
      const uci = `${sourceSquare}${targetSquare}${promotion ?? ''}`;
      const ok = sendMsg({ type: 'move', uci, clientTs: Date.now() });
      return ok;
    },
    [role, sendMsg, state],
  );

  const squareStyles = useMemo<Record<string, React.CSSProperties>>(() => {
    if (!state?.lastMove) return {};
    const from = state.lastMove.uci.slice(0, 2);
    const to = state.lastMove.uci.slice(2, 4);
    return {
      [from]: { background: BOARD_LAST_MOVE_TINT },
      [to]: { background: BOARD_LAST_MOVE_TINT },
    };
  }, [state?.lastMove]);

  if (!state) {
    return (
      <div className="flex h-96 items-center justify-center text-sm text-muted-foreground">
        {connected ? 'Loading position…' : 'Connecting…'}
      </div>
    );
  }

  const orientation: 'white' | 'black' = role;
  const topClockMs = role === 'white' ? localClock.blackMs : localClock.whiteMs;
  const bottomClockMs = role === 'white' ? localClock.whiteMs : localClock.blackMs;
  const topActive = state.sideToMove !== role;
  const bottomActive = state.sideToMove === role;
  const ended = state.status !== 'live';

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div ref={containerRef} className="mx-auto w-full" style={{ maxWidth: `${MAX_BOARD}px` }}>
        <ClockChip
          ms={topClockMs}
          active={topActive}
          label={role === 'white' ? 'Black' : 'White'}
        />
        <div
          className="my-2 overflow-hidden rounded-md"
          style={{ border: `2px solid ${BOARD_BORDER}` }}
        >
          <Chessboard
            position={state.fen}
            boardWidth={boardWidth}
            boardOrientation={orientation}
            customDarkSquareStyle={{ backgroundColor: BOARD_DARK_SQUARE }}
            customLightSquareStyle={{ backgroundColor: BOARD_LIGHT_SQUARE }}
            customSquareStyles={squareStyles}
            arePiecesDraggable={!ended && state.sideToMove === role}
            onPieceDrop={onPieceDrop}
            showBoardNotation={prefs.showCoordinates}
            animationDuration={prefs.animationsEnabled ? 200 : 0}
          />
        </div>
        <ClockChip
          ms={bottomClockMs}
          active={bottomActive}
          label={role === 'white' ? 'White (you)' : 'Black (you)'}
        />
      </div>

      <aside className="space-y-3">
        <div className="rounded-lg border border-border bg-card p-3">
          <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            Connection
          </p>
          <p className="text-sm">{connected ? 'Live' : 'Reconnecting…'}</p>
        </div>

        <div className="rounded-lg border border-border bg-card p-3">
          <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">PGN</p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px]">
            {state.pgn || '—'}
          </pre>
        </div>

        {drawOfferedFrom && drawOfferedFrom !== role && !ended && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <p className="mb-2">Opponent offers a draw.</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => sendMsg({ type: 'accept_draw' })}
                className="flex-1 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground"
              >
                Accept
              </button>
              <button
                type="button"
                onClick={() => sendMsg({ type: 'decline_draw' })}
                className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs"
              >
                Decline
              </button>
            </div>
          </div>
        )}

        {!ended && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => sendMsg({ type: 'offer_draw' })}
              disabled={!connected}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-60"
            >
              Offer draw
            </button>
            <button
              type="button"
              onClick={() => {
                if (window.confirm('Resign this game?')) sendMsg({ type: 'resign' });
              }}
              disabled={!connected}
              className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-60"
            >
              Resign
            </button>
          </div>
        )}

        {ended && (
          <div className="rounded-lg border border-accent/40 bg-accent/5 p-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-accent">Game over</p>
            <p className="mt-1 text-base">
              {state.result} — {state.termination}
            </p>
            <button
              type="button"
              onClick={() => router.push(`/practice/g/${matchId}/review`)}
              className="mt-3 w-full rounded-md bg-accent px-3 py-2 text-sm font-semibold text-accent-foreground"
            >
              Review with Stockfish →
            </button>
          </div>
        )}

        {error && (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
            {error}
          </p>
        )}
      </aside>
    </div>
  );
}

function ClockChip({ ms, active, label }: { ms: number; active: boolean; label: string }) {
  return (
    <div
      className={`flex items-center justify-between rounded-md px-3 py-2 ${
        active ? 'bg-accent/15 ring-1 ring-accent/40' : 'bg-card'
      }`}
    >
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span
        className={`font-display text-2xl font-bold tabular-nums ${ms < 10_000 ? 'text-destructive' : ''}`}
      >
        {fmtClock(ms)}
      </span>
    </div>
  );
}

/**
 * Locally interpolate clock counts between server ticks for a smooth display.
 * Server ticks arrive ~1Hz; we update at ~10Hz between them.
 */
function useLocalClock(state: GameState | null): { whiteMs: number; blackMs: number } {
  const [local, setLocal] = useState<{ whiteMs: number; blackMs: number }>({
    whiteMs: 0,
    blackMs: 0,
  });
  const baseRef = useRef<{
    at: number;
    whiteMs: number;
    blackMs: number;
    side: Color | null;
  } | null>(null);

  useEffect(() => {
    if (!state) return;
    baseRef.current = {
      at: Date.now(),
      whiteMs: state.whiteMs,
      blackMs: state.blackMs,
      side: state.status === 'live' ? state.sideToMove : null,
    };
    setLocal({ whiteMs: state.whiteMs, blackMs: state.blackMs });
  }, [state]);

  useEffect(() => {
    const id = setInterval(() => {
      const base = baseRef.current;
      if (!base) return;
      const elapsed = Date.now() - base.at;
      if (base.side === 'white') {
        setLocal({ whiteMs: Math.max(0, base.whiteMs - elapsed), blackMs: base.blackMs });
      } else if (base.side === 'black') {
        setLocal({ whiteMs: base.whiteMs, blackMs: Math.max(0, base.blackMs - elapsed) });
      } else {
        setLocal({ whiteMs: base.whiteMs, blackMs: base.blackMs });
      }
    }, 100);
    return () => clearInterval(id);
  }, []);

  return local;
}
