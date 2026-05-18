'use client';

/**
 * GamePlayer: the live game UI. Connects to the realtime server via the
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
import { Chess } from 'chess.js';
import type { Piece, Square } from 'react-chessboard/dist/chessboard/types';
import type { ClientMsg, Color, Result, ServerMsg, Termination } from '@/lib/practice/protocol';
import { sounds } from '@/lib/practice/sounds';
import { MovesPanel } from './MovesPanel';
import { PlayerCard, type PlayerInfo } from './PlayerCard';
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
  initialFen: string;
  prefs: Prefs;
  whitePlayer: PlayerInfo;
  blackPlayer: PlayerInfo;
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
  paused: boolean;
}

interface OpponentPresence {
  reason: 'waiting' | 'disconnected';
  deadlineMs: number | null;
}

const SIDEBAR_WIDTH = 300;
const FALLBACK_VERTICAL_CHROME = 180; // used until the first chrome measurement lands
const MIN_BOARD = 280;
const MAX_BOARD = 1280; // sane upper bound on giant displays so pieces stay legible
const RECONNECT_DELAYS_MS = [500, 1500, 3000, 6000, 12000];

function computeBoardSize(verticalChrome: number): number {
  if (typeof window === 'undefined') return 560;
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  // On wide screens the sidebar sits beside the board; below the `lg`
  // breakpoint (~1024px) it stacks below, so the board can use the full width.
  const sidebar = vw >= 1024 ? SIDEBAR_WIDTH + 32 : 0;
  const widthCap = vw - sidebar - 32;
  const heightCap = vh - verticalChrome;
  return Math.max(MIN_BOARD, Math.min(MAX_BOARD, Math.floor(Math.min(widthCap, heightCap))));
}

function sideToMoveFromFen(fen: string): Color {
  return fen.split(' ')[1] === 'b' ? 'black' : 'white';
}

export function GamePlayer({
  matchId,
  initialWsUrl,
  initialRole,
  initialFen,
  prefs,
  whitePlayer,
  blackPlayer,
}: Props) {
  const router = useRouter();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempt = useRef(0);
  const closedIntentionally = useRef(false);
  const startSoundFired = useRef(false);
  const columnRef = useRef<HTMLDivElement | null>(null);
  const topChromeRef = useRef<HTMLDivElement | null>(null);
  const bottomChromeRef = useRef<HTMLDivElement | null>(null);
  const [boardWidth, setBoardWidth] = useState(560);
  const [isDesktop, setIsDesktop] = useState(false);
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<GameState | null>(null);
  const [role] = useState<Color>(initialRole);
  const [drawOfferedFrom, setDrawOfferedFrom] = useState<Color | null>(null);
  const [opponentPresence, setOpponentPresence] = useState<OpponentPresence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const localClock = useLocalClock(state);

  useEffect(() => {
    sounds.setEnabled(prefs.soundEnabled);
  }, [prefs.soundEnabled]);

  // Preload sound samples so the first move/capture doesn't stall on a
  // cold network fetch from /sounds/practice/.
  useEffect(() => {
    sounds.preload();
  }, []);

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

  // Track the `lg` breakpoint so the player cards can live above/below the
  // board on mobile but move into the sidebar on desktop. That frees the
  // board column to use the full vertical space.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const apply = () => setIsDesktop(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // Sizing the board: instead of guessing how much vertical space the clocks
  // and page padding consume, measure the actual chrome above and below the
  // board so the board grows to the largest square that fits. Re-runs once
  // `state` arrives so the refs are attached to the real layout (not the
  // "Loading position…" placeholder), and when the breakpoint flips so the
  // chrome budget is recomputed for the new layout.
  const stateReady = state !== null;
  useEffect(() => {
    function update() {
      const col = columnRef.current;
      let verticalChrome = FALLBACK_VERTICAL_CHROME;
      if (col) {
        const colTop = col.getBoundingClientRect().top;
        // On desktop the player cards are rendered inside the sidebar, so they
        // contribute zero to the board column's vertical chrome.
        const topH = isDesktop ? 0 : (topChromeRef.current?.offsetHeight ?? 0);
        const bottomH = isDesktop ? 0 : (bottomChromeRef.current?.offsetHeight ?? 0);
        // 36px = my-2 around the board (16) + 2px border ×2 (4) + main pb-4 (16).
        verticalChrome = colTop + topH + bottomH + 36;
      }
      setBoardWidth(computeBoardSize(verticalChrome));
    }
    update();
    window.addEventListener('resize', update);
    let ro: ResizeObserver | null = null;
    if (!isDesktop && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(update);
      if (topChromeRef.current) ro.observe(topChromeRef.current);
      if (bottomChromeRef.current) ro.observe(bottomChromeRef.current);
    }
    return () => {
      window.removeEventListener('resize', update);
      ro?.disconnect();
    };
  }, [stateReady, isDesktop]);

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
          setError('Lost connection. The game may be over.');
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

  const onMessage = useCallback(
    (raw: string | ArrayBuffer | Blob) => {
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
            paused: msg.paused,
          });
          // Fire the "fight start" gong once, the first time we see a live game
          // with no moves played yet. After any move lastMove is non-null, so
          // reconnects mid-game won't re-trigger this.
          if (!startSoundFired.current && msg.status === 'live' && !msg.lastMove) {
            startSoundFired.current = true;
            sounds.play('gameStart');
          }
          return;
        case 'move':
          setState((s) =>
            s
              ? {
                  ...s,
                  fen: msg.fen,
                  whiteMs: msg.whiteTimeMs,
                  blackMs: msg.blackTimeMs,
                  // Derive from FEN: otherwise an own optimistic flip + this
                  // unconditional flip would cancel out and stick on our color.
                  sideToMove: sideToMoveFromFen(msg.fen),
                  lastMove: { uci: msg.uci, san: msg.san },
                  // First move just landed (or any move). The clock is running.
                  paused: false,
                }
              : s,
          );
          if (/x/.test(msg.san)) sounds.play('capture');
          else if (/\+|#/.test(msg.san)) sounds.play('check');
          else sounds.play('move');
          setDrawOfferedFrom(null);
          return;
        case 'clock':
          setState((s) =>
            s
              ? { ...s, whiteMs: msg.whiteTimeMs, blackMs: msg.blackTimeMs, paused: msg.paused }
              : s,
          );
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
          if (msg.result === '1/2-1/2') sounds.play('draw');
          else if (
            (msg.result === '1-0' && role === 'white') ||
            (msg.result === '0-1' && role === 'black')
          )
            sounds.play('win');
          else sounds.play('loss');
          return;
        case 'draw_offer':
          setDrawOfferedFrom(msg.from);
          return;
        case 'draw_decline':
          setDrawOfferedFrom(null);
          return;
        case 'presence':
          // Only opponent's presence transitions drive the banner.
          if (msg.color === role) return;
          if (msg.connected) {
            setOpponentPresence(null);
          } else if (msg.reason === 'waiting' || msg.reason === 'disconnected') {
            setOpponentPresence({ reason: msg.reason, deadlineMs: msg.deadlineMs });
          }
          return;
        case 'error':
          setError(msg.message);
          return;
      }
    },
    [role],
  );

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

      // Optimistic local apply: without this the piece visibly snaps back to
      // its source square between the drop and the server's `move` echo,
      // because `position` is still bound to the pre-move FEN. Validate with
      // chess.js so an illegal drop is rejected here (cheaper than a round
      // trip) and rendered as a snap-back.
      const chess = new Chess(state.fen);
      let applied: { san: string; after: string } | null = null;
      try {
        const mv = chess.move({
          from: sourceSquare,
          to: targetSquare,
          promotion: promotion ?? 'q',
        });
        if (!mv) return false;
        applied = { san: mv.san, after: chess.fen() };
      } catch {
        return false;
      }

      const ok = sendMsg({ type: 'move', uci, clientTs: Date.now() });
      if (!ok) return false;

      setState((s) =>
        s
          ? {
              ...s,
              fen: applied!.after,
              sideToMove: s.sideToMove === 'white' ? 'black' : 'white',
              lastMove: { uci, san: applied!.san },
              paused: false,
            }
          : s,
      );
      return true;
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
  const topPlayer = role === 'white' ? blackPlayer : whitePlayer;
  const bottomPlayer = role === 'white' ? whitePlayer : blackPlayer;
  const topColor: 'white' | 'black' = role === 'white' ? 'black' : 'white';
  const bottomColor: 'white' | 'black' = role;

  return (
    <div className="flex flex-col items-center gap-4 lg:flex-row lg:items-start lg:justify-center">
      <div ref={columnRef} className="flex flex-col" style={{ width: boardWidth }}>
        {!isDesktop && (
          <div ref={topChromeRef}>
            {!ended && opponentPresence && (
              <PresenceBanner
                reason={opponentPresence.reason}
                deadlineMs={opponentPresence.deadlineMs}
              />
            )}
            <PlayerCard
              player={topPlayer}
              color={topColor}
              isYou={false}
              ms={topClockMs}
              active={topActive}
            />
          </div>
        )}
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
        {!isDesktop && (
          <div ref={bottomChromeRef}>
            <PlayerCard
              player={bottomPlayer}
              color={bottomColor}
              isYou={true}
              ms={bottomClockMs}
              active={bottomActive}
            />
          </div>
        )}
      </div>

      <aside className="w-full space-y-3 lg:w-[300px] lg:shrink-0">
        {isDesktop && (
          <div ref={topChromeRef}>
            {!ended && opponentPresence && (
              <PresenceBanner
                reason={opponentPresence.reason}
                deadlineMs={opponentPresence.deadlineMs}
              />
            )}
            <PlayerCard
              player={topPlayer}
              color={topColor}
              isYou={false}
              ms={topClockMs}
              active={topActive}
            />
          </div>
        )}
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center justify-between">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Moves</p>
            <span className={`text-[10px] ${connected ? 'text-accent' : 'text-muted-foreground'}`}>
              {connected ? '● Live' : '○ Reconnecting…'}
            </span>
          </div>
          <div className="mt-2">
            <MovesPanel pgn={state.pgn} initialFen={initialFen} />
          </div>
        </div>

        {isDesktop && (
          <div ref={bottomChromeRef}>
            <PlayerCard
              player={bottomPlayer}
              color={bottomColor}
              isYou={true}
              ms={bottomClockMs}
              active={bottomActive}
            />
          </div>
        )}

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
              {state.result}: {state.termination}
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

function useCountdown(deadlineMs: number | null): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (deadlineMs == null) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [deadlineMs]);
  if (deadlineMs == null) return 0;
  return Math.max(0, Math.ceil((deadlineMs - now) / 1000));
}

function PresenceBanner({
  reason,
  deadlineMs,
}: {
  reason: 'waiting' | 'disconnected';
  deadlineMs: number | null;
}) {
  const seconds = useCountdown(deadlineMs);
  const text =
    reason === 'waiting'
      ? `Waiting for opponent, ${seconds}s to abort`
      : `Opponent disconnected, ${seconds}s to return`;
  return (
    <div className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-center text-xs font-medium text-amber-700 dark:text-amber-300">
      {text}
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
      side: state.status === 'live' && !state.paused ? state.sideToMove : null,
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
