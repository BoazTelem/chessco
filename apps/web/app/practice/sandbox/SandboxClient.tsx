'use client';

/**
 * Sandbox client — runs the bot game state machine entirely in the browser.
 *
 * State machine (`Phase`):
 *   setup   — show pickers (time class / control / bot rating / mode), Start button
 *   loading — POST /start in flight
 *   playing — board active, user to move
 *   thinking — bot move fetch in flight
 *   settling — POST /end in flight after a terminal result
 *   done    — show outcome + credit delta + "play again"
 *
 * Trust model (v0): the client is the source of truth for game state. The
 * server is stateless between moves; it relays FENs to the Maia inference
 * service and trusts the result the client reports at /end. Abuse is bounded
 * by the daily cap (server-enforced) + audit logs + the rating-floor gate.
 *
 * Resign / unload behavior: the resign button POSTs result='user_loss',
 * result_reason='resign'. Window-unload (close tab, navigate away) sends a
 * sendBeacon to /end with result='abandoned' so a closed tab doesn't leave
 * a credit-mode game un-settled forever. The end route is idempotent — if
 * the user resigned cleanly and then closes the tab, the second POST returns
 * 409 and is ignored.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';

type TimeClass = 'bullet' | 'blitz' | 'rapid' | 'classical';
type GameMode = 'casual' | 'credit';
type LadderRating = 1500 | 1700 | 1900;

type Phase = 'setup' | 'loading' | 'playing' | 'thinking' | 'settling' | 'done';

interface StartResponse {
  game_id: string;
  weights_id: string;
  user_rating: number | null;
  bot_rating: number;
  mode: GameMode;
}

interface MoveResponse {
  uci: string;
  san: string;
  probability: number;
  latency_ms: number;
}

interface EndResponse {
  ok: true;
  credit_delta: number;
  result: string;
}

interface ApiError {
  error: string;
  message?: string;
  detail?: unknown;
}

interface GameSession extends StartResponse {
  startedAt: number;
}

interface FinishedState {
  result: 'user_win' | 'user_loss' | 'draw' | 'abandoned';
  resultReason: string;
  pgn: string;
  creditDelta?: number;
}

const TIME_CONTROLS: Record<TimeClass, readonly string[]> = {
  bullet: ['1+0', '2+1'],
  blitz: ['3+0', '3+2', '5+0', '5+3'],
  rapid: ['10+0', '15+10'],
  classical: ['30+0', '60+30'],
};

export default function SandboxClient(): JSX.Element {
  const [phase, setPhase] = useState<Phase>('setup');
  const [timeClass, setTimeClass] = useState<TimeClass>('blitz');
  const [timeControl, setTimeControl] = useState<string>('5+0');
  const [botRating, setBotRating] = useState<LadderRating>(1500);
  const [mode, setMode] = useState<GameMode>('casual');

  const [session, setSession] = useState<GameSession | null>(null);
  const [finished, setFinished] = useState<FinishedState | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // chess.js holds the authoritative game state. We keep a ref so the
  // onPieceDrop handler doesn't depend on a stale closure of an immutable
  // chess instance — chess.js mutates in place.
  const chessRef = useRef<Chess>(new Chess());
  const [fen, setFen] = useState<string>(chessRef.current.fen());

  // sendBeacon needs the game id when the page unloads. Stash it in a ref
  // so the unload handler doesn't capture a stale snapshot.
  const sessionIdRef = useRef<string | null>(null);
  const modeRef = useRef<GameMode>('casual');
  useEffect(() => {
    sessionIdRef.current = session?.game_id ?? null;
    modeRef.current = session?.mode ?? 'casual';
  }, [session]);

  const resetBoard = useCallback(() => {
    chessRef.current = new Chess();
    setFen(chessRef.current.fen());
  }, []);

  const onStart = useCallback(async (): Promise<void> => {
    setErrorMsg(null);
    setPhase('loading');
    try {
      const resp = await fetch('/api/practice/sandbox/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          bot_rating: botRating,
          time_class: timeClass,
          time_control: timeControl,
          mode,
        }),
      });
      const data = (await resp.json()) as StartResponse | ApiError;
      if (!resp.ok) {
        setErrorMsg(formatStartError(data as ApiError));
        setPhase('setup');
        return;
      }
      const startData = data as StartResponse;
      resetBoard();
      setSession({ ...startData, startedAt: Date.now() });
      setFinished(null);
      setPhase('playing');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase('setup');
    }
  }, [botRating, timeClass, timeControl, mode, resetBoard]);

  // Settle the game with the server. Called when a terminal position is
  // reached, when the user resigns, or via the unload sendBeacon.
  const settle = useCallback(
    async (result: FinishedState['result'], resultReason: string): Promise<void> => {
      const s = session;
      if (!s) return;
      setPhase('settling');
      const pgn = chessRef.current.pgn();
      try {
        const resp = await fetch('/api/practice/sandbox/end', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            game_id: s.game_id,
            result,
            result_reason: resultReason,
            pgn,
          }),
        });
        const data = (await resp.json()) as EndResponse | ApiError;
        if (!resp.ok) {
          setErrorMsg(formatEndError(data as ApiError));
          // Still mark done — the game is over either way; just no credit delta.
          setFinished({ result, resultReason, pgn });
          setPhase('done');
          return;
        }
        setFinished({
          result,
          resultReason,
          pgn,
          creditDelta: (data as EndResponse).credit_delta,
        });
        setPhase('done');
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setFinished({ result, resultReason, pgn });
        setPhase('done');
      }
    },
    [session],
  );

  // After every position change, detect terminal states and trigger settle.
  const checkTerminal = useCallback(
    (chess: Chess): { result: FinishedState['result']; reason: string } | null => {
      if (chess.isCheckmate()) {
        // chess.js: side to move is the one that got mated.
        const userIsWhite = true; // sandbox plays White-only for v0
        const mated = chess.turn(); // 'w' or 'b'
        const userMated = userIsWhite ? mated === 'w' : mated === 'b';
        return { result: userMated ? 'user_loss' : 'user_win', reason: 'checkmate' };
      }
      if (chess.isStalemate()) return { result: 'draw', reason: 'stalemate' };
      if (chess.isThreefoldRepetition()) return { result: 'draw', reason: 'threefold' };
      if (chess.isInsufficientMaterial()) {
        return { result: 'draw', reason: 'insufficient_material' };
      }
      if (chess.isDraw()) return { result: 'draw', reason: '50_move' };
      return null;
    },
    [],
  );

  const fetchBotMove = useCallback(
    async (currentFen: string): Promise<MoveResponse | null> => {
      const s = session;
      if (!s) return null;
      const resp = await fetch('/api/practice/sandbox/move', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ game_id: s.game_id, fen: currentFen }),
      });
      const data = (await resp.json()) as MoveResponse | ApiError;
      if (!resp.ok) {
        setErrorMsg(formatMoveError(data as ApiError));
        return null;
      }
      return data as MoveResponse;
    },
    [session],
  );

  const onPieceDrop = useCallback(
    (sourceSquare: string, targetSquare: string, piece: string): boolean => {
      if (phase !== 'playing') return false;
      const chess = chessRef.current;
      // Only allow user moves when it's user (White) to move.
      if (chess.turn() !== 'w') return false;

      const promotionPiece = piece && piece.length > 1 ? piece[1]!.toLowerCase() : undefined;
      const move = chess.move({
        from: sourceSquare,
        to: targetSquare,
        promotion: promotionPiece ?? 'q',
      });
      if (!move) return false;

      setFen(chess.fen());

      // Detect terminal AFTER user's move.
      const terminal = checkTerminal(chess);
      if (terminal) {
        void settle(terminal.result, terminal.reason);
        return true;
      }

      // Otherwise fire the bot's move.
      setPhase('thinking');
      void (async () => {
        const bot = await fetchBotMove(chess.fen());
        if (!bot) {
          // Move failed — leave the game playable so the user can resign or
          // wait for the inference service to recover. We don't auto-settle
          // because that would unfairly cost a credit in credit mode.
          setPhase('playing');
          return;
        }
        const botMove = chess.move(bot.uci);
        if (!botMove) {
          // Maia returned an illegal move — defensive fallback. Log + revert.
          setErrorMsg(`Bot returned illegal move: ${bot.uci}`);
          setPhase('playing');
          return;
        }
        setFen(chess.fen());
        const afterBot = checkTerminal(chess);
        if (afterBot) {
          void settle(afterBot.result, afterBot.reason);
          return;
        }
        setPhase('playing');
      })();

      return true;
    },
    [phase, checkTerminal, fetchBotMove, settle],
  );

  const onResign = useCallback(() => {
    void settle('user_loss', 'resign');
  }, [settle]);

  // Unload handler: if a credit-mode game is mid-play, send a beacon to
  // mark it abandoned. The end route is idempotent so this is safe to fire
  // even when no actual abandonment is happening.
  useEffect(() => {
    const handler = (): void => {
      const id = sessionIdRef.current;
      if (!id) return;
      if (modeRef.current !== 'credit') return; // casual games can be ignored
      const body = JSON.stringify({
        game_id: id,
        result: 'abandoned',
        result_reason: 'disconnect',
        pgn: chessRef.current.pgn() || '*',
      });
      try {
        navigator.sendBeacon(
          '/api/practice/sandbox/end',
          new Blob([body], { type: 'application/json' }),
        );
      } catch {
        // sendBeacon is best-effort; nothing actionable on failure.
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const onPlayAgain = useCallback(() => {
    setSession(null);
    setFinished(null);
    setErrorMsg(null);
    resetBoard();
    setPhase('setup');
  }, [resetBoard]);

  const renderSetup = (): JSX.Element => {
    const controls = TIME_CONTROLS[timeClass];
    // The credit toggle is allowed in the UI; the server is the source of
    // truth for whether it's actually usable. If the user picks credit + a
    // sub-rating bot, /start returns 400 with the precise reason.
    return (
      <section className="rounded-lg border border-border bg-card p-5 md:p-6">
        <h2 className="text-lg font-semibold">New game</h2>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Field label="Time class">
            <select
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              value={timeClass}
              onChange={(e) => {
                const tc = e.target.value as TimeClass;
                setTimeClass(tc);
                setTimeControl(TIME_CONTROLS[tc][0]!);
              }}
            >
              <option value="bullet">Bullet</option>
              <option value="blitz">Blitz</option>
              <option value="rapid">Rapid</option>
              <option value="classical">Classical</option>
            </select>
          </Field>

          <Field label="Time control">
            <select
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              value={timeControl}
              onChange={(e) => setTimeControl(e.target.value)}
            >
              {controls.map((tc) => (
                <option key={tc} value={tc}>
                  {tc}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Bot rating">
            <div className="flex gap-2">
              {([1500, 1700, 1900] as const).map((r) => (
                <button
                  type="button"
                  key={r}
                  onClick={() => setBotRating(r)}
                  className={
                    'flex-1 rounded-md border px-3 py-1.5 text-sm ' +
                    (botRating === r
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-background')
                  }
                >
                  {r}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Mode">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setMode('casual')}
                className={
                  'flex-1 rounded-md border px-3 py-1.5 text-sm ' +
                  (mode === 'casual'
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background')
                }
              >
                Casual
              </button>
              <button
                type="button"
                onClick={() => setMode('credit')}
                className={
                  'flex-1 rounded-md border px-3 py-1.5 text-sm ' +
                  (mode === 'credit'
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background')
                }
              >
                Credit (±1)
              </button>
            </div>
          </Field>
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          Credit mode requires the bot rating ≥ your verified rating in this time class and at least
          one credit available. If either check fails, the server will refuse the start and surface
          the reason.
        </p>

        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            onClick={onStart}
            disabled={phase === 'loading'}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {phase === 'loading' ? 'Starting…' : 'Start game'}
          </button>
          {errorMsg ? <span className="text-xs text-red-400">{errorMsg}</span> : null}
        </div>
      </section>
    );
  };

  const renderGame = (): JSX.Element => {
    const turnLabel = (() => {
      if (phase === 'thinking') return 'Bot is thinking…';
      if (phase === 'settling') return 'Settling…';
      if (phase === 'playing') return 'Your move';
      return '';
    })();
    return (
      <section className="grid gap-6 md:grid-cols-[1fr_18rem]">
        <div className="flex flex-col items-stretch">
          <Chessboard
            position={fen}
            onPieceDrop={onPieceDrop}
            boardOrientation="white"
            arePiecesDraggable={phase === 'playing'}
            customBoardStyle={{ borderRadius: 8 }}
          />
          <p className="mt-3 text-sm text-muted-foreground">{turnLabel}</p>
        </div>
        <aside className="flex flex-col gap-4">
          <div className="rounded-lg border border-border bg-card p-4 text-sm">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Opponent</p>
            <p className="mt-1 text-lg font-semibold">Maia {session?.bot_rating}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Plays at approximately {session?.bot_rating} Elo (human-style, not engine).
            </p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4 text-sm">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Game</p>
            <p className="mt-1">
              <span className="text-muted-foreground">Mode:</span>{' '}
              <span className="font-medium">{session?.mode}</span>
            </p>
            <p>
              <span className="text-muted-foreground">Time:</span>{' '}
              <span className="font-medium">{timeControl}</span> ({timeClass})
            </p>
            {session?.user_rating !== null && session?.user_rating !== undefined ? (
              <p>
                <span className="text-muted-foreground">Your rating:</span>{' '}
                <span className="font-medium">{session.user_rating}</span>
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onResign}
            disabled={phase !== 'playing' && phase !== 'thinking'}
            className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300 hover:bg-red-500/20 disabled:opacity-50"
          >
            Resign
          </button>
          {errorMsg ? <p className="text-xs text-red-400">{errorMsg}</p> : null}
        </aside>
      </section>
    );
  };

  const renderDone = (): JSX.Element => {
    if (!finished) return <p>Game ended.</p>;
    const headline = (() => {
      switch (finished.result) {
        case 'user_win':
          return 'You won';
        case 'user_loss':
          return 'You lost';
        case 'draw':
          return 'Draw';
        case 'abandoned':
          return 'Abandoned';
      }
    })();
    const creditCopy = (() => {
      if (finished.creditDelta === undefined) return null;
      if (finished.creditDelta === 0) return 'No credit change.';
      if (finished.creditDelta > 0) return `+${finished.creditDelta} credit`;
      return `${finished.creditDelta} credit`;
    })();
    return (
      <section className="rounded-lg border border-border bg-card p-6">
        <h2 className="text-xl font-semibold">{headline}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          via <code className="rounded bg-muted px-1 py-0.5 text-xs">{finished.resultReason}</code>
        </p>
        {creditCopy ? (
          <p className="mt-3 text-base">
            <span className="text-muted-foreground">Credits:</span>{' '}
            <span className="font-semibold">{creditCopy}</span>
          </p>
        ) : null}
        {errorMsg ? <p className="mt-3 text-xs text-red-400">{errorMsg}</p> : null}
        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            onClick={onPlayAgain}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Play again
          </button>
        </div>
      </section>
    );
  };

  return useMemo(() => {
    if (phase === 'setup' || phase === 'loading') return renderSetup();
    if (phase === 'done') return renderDone();
    return renderGame();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, fen, errorMsg, finished, session, timeClass, timeControl, botRating, mode]);
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

function formatStartError(err: ApiError): string {
  if (err.error === 'credit_mode_unavailable') {
    const detail = err.detail as
      | { reason?: string; userRating?: number; botRating?: number }
      | undefined;
    if (detail?.reason === 'no_verified_rating') {
      return 'Credit mode requires a verified chess.com or lichess account in this time class. Link one in your account settings.';
    }
    if (detail?.reason === 'bot_below_user') {
      return `Credit mode requires the bot rating to be at or above your verified rating (${detail.userRating}). Pick a higher bucket or switch to casual.`;
    }
    return 'Credit mode is not available for this configuration.';
  }
  if (err.error === 'insufficient_credits') {
    const detail = err.detail as { available?: number } | undefined;
    return `You need at least 1 credit to start a credit-mode game (you have ${detail?.available ?? 0}).`;
  }
  if (err.error === 'credit_mode_game_in_progress') {
    return 'You already have a credit-mode game in progress. Finish or resign it first.';
  }
  if (err.error === 'credit_mode_daily_cap') {
    return 'Daily credit-mode cap reached (20 games / 24h). Switch to casual or come back tomorrow.';
  }
  if (err.error === 'ladder_not_seeded') {
    return err.message ?? 'The Maia ladder rows are not seeded yet — operator action needed.';
  }
  return err.message ?? err.error ?? 'Failed to start game.';
}

function formatMoveError(err: ApiError): string {
  if (err.error === 'inference_unconfigured') {
    return 'The Maia inference service is not configured. Deploy it and set MAIA_INFERENCE_URL.';
  }
  if (err.error === 'weights_not_ready') {
    return 'The opponent bot is still being trained. Try again in a few minutes.';
  }
  if (err.error === 'inference_error') {
    return `Inference service hiccup: ${err.message ?? 'unknown error'}. Try the move again.`;
  }
  if (err.error === 'game_not_found') return 'This game session has expired.';
  if (err.error === 'game_already_ended') return 'This game is already over.';
  return err.message ?? err.error ?? 'Failed to fetch bot move.';
}

function formatEndError(err: ApiError): string {
  if (err.error === 'insufficient_credits') {
    return 'Could not settle the loss — your credit balance is too low. The game is over locally but the credit delta did not apply.';
  }
  if (err.error === 'game_not_found_or_already_ended') {
    return 'This game has already been settled.';
  }
  return err.message ?? err.error ?? 'Failed to settle game.';
}
