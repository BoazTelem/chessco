import { Chess } from 'chess.js';
import type { WebSocket } from 'ws';
import {
  applyMove as applyClockMove,
  hasFlagged,
  makeClock,
  pause as pauseClock,
  resume as resumeClock,
  tick as tickClock,
  type ClockState,
} from './clock';
import {
  finalizeGame,
  loadMatchContext,
  persistMove,
  type LiveGameRow,
  type MatchRow,
} from './persist';
import { notifySettle } from './settle';
import type { ClientMsg, Color, Result, ServerMsg, Termination } from './types';

/**
 * One GameRoom per active match. In-memory state is the authoritative copy
 * during play; every accepted ply is persisted before broadcast, so a server
 * crash means at most "one ply lost" not "diverged state".
 *
 * Rooms are pruned ~30s after the game ends so post-game review can pull
 * the final state via DB instead of WS.
 */

interface Member {
  userId: string;
  color: Color;
  socket: WebSocket;
  disconnectedAt: number | null;
}

function graceMsFor(timeControl: string): number {
  const base = Number(/^(\d+)\+/.exec(timeControl)?.[1] ?? '5') * 60_000;
  if (base <= 2 * 60_000) return 15_000;
  if (base <= 5 * 60_000) return 30_000;
  if (base <= 15 * 60_000) return 60_000;
  return 120_000;
}

// How long the present player waits before we abort a game whose opponent
// never connected at all. 60s absorbs slow page-load / flaky-internet without
// stranding the joiner indefinitely.
const WAITING_MS = 60_000;
// Once both players are at the board, the side-to-move has this long to play
// the first ply. Mirrors Lichess's first-move abort timer.
const FIRST_MOVE_MS = 30_000;

export class GameRoom {
  private chess: Chess;
  private clock: ClockState;
  private match: MatchRow;
  private liveGame: LiveGameRow;
  private members: Map<string, Member> = new Map(); // userId → Member
  private drawOfferFrom: Color | null = null;
  private ended = false;
  private clockBroadcastTimer: NodeJS.Timeout | null = null;
  private flagCheckTimer: NodeJS.Timeout | null = null;
  private abandonmentTimer: NodeJS.Timeout | null = null;
  private waitingTimer: NodeJS.Timeout | null = null;
  private firstMoveTimer: NodeJS.Timeout | null = null;
  private readonly graceMs: number;

  static async load(matchId: string): Promise<GameRoom | null> {
    const ctx = await loadMatchContext(matchId);
    if (!ctx) return null;
    return new GameRoom(ctx.match, ctx.liveGame);
  }

  private constructor(match: MatchRow, liveGame: LiveGameRow) {
    this.match = match;
    this.liveGame = liveGame;

    this.chess = new Chess();
    // Hydrate from the persisted state: prefer current_fen + pgn if present,
    // otherwise start from initial_fen.
    if (liveGame.pgn) {
      try {
        this.chess = new Chess(liveGame.initial_fen);
        this.chess.loadPgn(liveGame.pgn);
      } catch {
        this.chess = new Chess(liveGame.current_fen ?? liveGame.initial_fen);
      }
    } else {
      this.chess = new Chess(liveGame.initial_fen);
    }

    const initialClock = makeClock(
      liveGame.time_control,
      this.chess.turn() === 'w' ? 'white' : 'black',
    );
    this.clock = {
      ...initialClock,
      whiteMs: liveGame.white_time_ms ?? initialClock.whiteMs,
      blackMs: liveGame.black_time_ms ?? initialClock.blackMs,
      // Pause until at least one move has been played AND both players are connected.
      paused: !this.hasFirstMove(),
    };
    this.graceMs = graceMsFor(liveGame.time_control);
  }

  get id(): string {
    return this.match.id;
  }
  get isEnded(): boolean {
    return this.ended;
  }

  private hasFirstMove(): boolean {
    return this.chess.history().length > 0;
  }

  attach(userId: string, role: Color, socket: WebSocket): void {
    // If they were already connected, drop the old socket cleanly.
    const existing = this.members.get(userId);
    if (existing && existing.socket !== socket) {
      try {
        existing.socket.close(4000, 'replaced');
      } catch {
        /* ignore */
      }
    }

    this.members.set(userId, { userId, color: role, socket, disconnectedAt: null });

    socket.on('message', (data) => this.handleMessage(userId, data.toString()));
    socket.on('close', () => this.handleDisconnect(userId));
    socket.on('error', () => this.handleDisconnect(userId));

    this.sendState(socket, role);

    if (this.ended) return;

    if (this.allConnected()) {
      // Both seats filled. Clear any "absent opponent" timers.
      if (this.waitingTimer) {
        clearTimeout(this.waitingTimer);
        this.waitingTimer = null;
      }
      if (this.abandonmentTimer) {
        clearTimeout(this.abandonmentTimer);
        this.abandonmentTimer = null;
      }

      // Announce this player's arrival/return so the opponent's banner clears.
      this.broadcast({
        type: 'presence',
        color: role,
        connected: true,
        reason: 'reconnected',
        deadlineMs: null,
      });

      if (this.hasFirstMove()) {
        // Game already in progress — resume clock and tell clients.
        this.clock = resumeClock(this.clock);
        this.startTimers();
        this.broadcast({
          type: 'clock',
          whiteTimeMs: this.clock.whiteMs,
          blackTimeMs: this.clock.blackMs,
          paused: this.clock.paused,
        });
      } else if (!this.firstMoveTimer) {
        // Both present, no moves yet — start first-move abort timer.
        const deadlineMs = Date.now() + FIRST_MOVE_MS;
        this.firstMoveTimer = setTimeout(() => {
          if (this.ended || this.hasFirstMove()) return;
          void this.endGame('*', 'aborted');
        }, FIRST_MOVE_MS);
        this.broadcast({
          type: 'presence',
          color: this.clock.sideToMove,
          connected: true,
          reason: 'first_move',
          deadlineMs,
        });
      }
    } else if (!this.hasFirstMove() && !this.waitingTimer) {
      // Single-occupant, no moves yet — start the waiting-for-opponent timer.
      const deadlineMs = Date.now() + WAITING_MS;
      this.waitingTimer = setTimeout(() => {
        if (this.ended || this.allConnected()) return;
        void this.endGame('*', 'aborted');
      }, WAITING_MS);
      const absentColor: Color = role === 'white' ? 'black' : 'white';
      this.sendTo(userId, {
        type: 'presence',
        color: absentColor,
        connected: false,
        reason: 'waiting',
        deadlineMs,
      });
    }
  }

  private allConnected(): boolean {
    return (
      this.members.has(this.liveGame.white_user_id) &&
      this.members.has(this.liveGame.black_user_id) &&
      [...this.members.values()].every((m) => m.disconnectedAt === null)
    );
  }

  private sendState(socket: WebSocket, role: Color): void {
    const lastMoves = this.chess.history({ verbose: true });
    const last = lastMoves[lastMoves.length - 1];
    const msg: ServerMsg = {
      type: 'state',
      fen: this.chess.fen(),
      pgn: this.chess.pgn(),
      whiteTimeMs: this.clock.whiteMs,
      blackTimeMs: this.clock.blackMs,
      sideToMove: this.clock.sideToMove,
      lastMove: last
        ? {
            san: last.san,
            uci: `${last.from}${last.to}${last.promotion ?? ''}`,
            ply: lastMoves.length,
          }
        : null,
      youAre: role,
      whiteUserId: this.liveGame.white_user_id,
      blackUserId: this.liveGame.black_user_id,
      status: this.liveGame.status,
      result: null,
      termination: null,
      paused: this.clock.paused,
    };
    socket.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMsg): void {
    const data = JSON.stringify(msg);
    for (const m of this.members.values()) {
      if (m.socket.readyState === m.socket.OPEN) {
        try {
          m.socket.send(data);
        } catch {
          /* ignore broken pipe */
        }
      }
    }
  }

  private sendTo(userId: string, msg: ServerMsg): void {
    const m = this.members.get(userId);
    if (m && m.socket.readyState === m.socket.OPEN) {
      try {
        m.socket.send(JSON.stringify(msg));
      } catch {
        /* ignore */
      }
    }
  }

  private async handleMessage(userId: string, raw: string): Promise<void> {
    let parsed: ClientMsg;
    try {
      parsed = JSON.parse(raw) as ClientMsg;
    } catch {
      return;
    }
    if (this.ended) return;

    switch (parsed.type) {
      case 'move':
        await this.handleMove(userId, parsed.uci, parsed.clientTs);
        return;
      case 'resign':
        await this.handleResign(userId);
        return;
      case 'offer_draw':
        this.handleDrawOffer(userId);
        return;
      case 'accept_draw':
        await this.handleDrawAccept(userId);
        return;
      case 'decline_draw':
        this.handleDrawDecline(userId);
        return;
      case 'abort':
        await this.handleAbort(userId);
        return;
    }
  }

  private async handleMove(userId: string, uci: string, clientTs: number): Promise<void> {
    const member = this.members.get(userId);
    if (!member) return;
    const myColor = member.color;
    if (this.clock.sideToMove !== myColor) {
      this.sendTo(userId, { type: 'error', code: 'not_your_turn', message: 'Not your turn.' });
      return;
    }

    // chess.js move() returns null on illegal move.
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    const moveAttempt = this.chess.move({ from, to, promotion });
    if (!moveAttempt) {
      this.sendTo(userId, { type: 'error', code: 'illegal_move', message: 'Illegal move.' });
      return;
    }

    // Check the flag pre-apply (mover ran out of time before submitting).
    const nowMs = Date.now();
    if (hasFlagged(this.clock, nowMs)) {
      // Roll back the move; the mover lost on time.
      this.chess.undo();
      await this.endGame(myColor === 'white' ? '0-1' : '1-0', 'timeout');
      return;
    }

    // First move just landed — cancel the first-move abort timer.
    if (this.firstMoveTimer) {
      clearTimeout(this.firstMoveTimer);
      this.firstMoveTimer = null;
    }

    this.clock = applyClockMove(this.clock, nowMs);
    const ply = this.chess.history().length;
    const fen = this.chess.fen();
    const pgn = this.chess.pgn();

    await persistMove({
      matchId: this.match.id,
      liveGameId: this.liveGame.id,
      ply,
      san: moveAttempt.san,
      uci,
      whiteTimeMs: this.clock.whiteMs,
      blackTimeMs: this.clock.blackMs,
      currentFen: fen,
      pgn,
      clientTs,
    });
    this.liveGame.pgn = pgn;
    this.liveGame.current_fen = fen;

    // Reset any open draw offer (a move declines it implicitly).
    this.drawOfferFrom = null;

    this.broadcast({
      type: 'move',
      san: moveAttempt.san,
      uci,
      ply,
      fen,
      whiteTimeMs: this.clock.whiteMs,
      blackTimeMs: this.clock.blackMs,
    });

    // Check for natural game end.
    if (this.chess.isCheckmate()) {
      await this.endGame(myColor === 'white' ? '1-0' : '0-1', 'checkmate');
      return;
    }
    if (this.chess.isStalemate()) {
      await this.endGame('1/2-1/2', 'stalemate');
      return;
    }
    if (this.chess.isInsufficientMaterial()) {
      await this.endGame('1/2-1/2', 'insufficient_material');
      return;
    }
    if (this.chess.isThreefoldRepetition()) {
      await this.endGame('1/2-1/2', 'threefold_repetition');
      return;
    }
    if (this.chess.isDraw()) {
      await this.endGame('1/2-1/2', 'fifty_moves');
      return;
    }

    if (!this.clockBroadcastTimer) this.startTimers();
  }

  private async handleResign(userId: string): Promise<void> {
    const m = this.members.get(userId);
    if (!m) return;
    const result: Result = m.color === 'white' ? '0-1' : '1-0';
    await this.endGame(result, 'resign');
  }

  private handleDrawOffer(userId: string): void {
    const m = this.members.get(userId);
    if (!m) return;
    this.drawOfferFrom = m.color;
    this.broadcast({ type: 'draw_offer', from: m.color });
  }

  private async handleDrawAccept(userId: string): Promise<void> {
    const m = this.members.get(userId);
    if (!m || !this.drawOfferFrom || this.drawOfferFrom === m.color) return;
    await this.endGame('1/2-1/2', 'agreed_draw');
  }

  private handleDrawDecline(userId: string): void {
    const m = this.members.get(userId);
    if (!m) return;
    this.drawOfferFrom = null;
    this.broadcast({ type: 'draw_decline', from: m.color });
  }

  private async handleAbort(userId: string): Promise<void> {
    // Abort is only allowed before the first move is played, by either side.
    if (this.hasFirstMove()) return;
    if (!this.members.has(userId)) return;
    await this.endGame('*', 'aborted');
  }

  private handleDisconnect(userId: string): void {
    const m = this.members.get(userId);
    if (!m) return;
    m.disconnectedAt = Date.now();

    // Pause the clock during grace so the present player isn't punished
    // (only meaningful once the clock has actually started ticking).
    if (!this.ended && this.hasFirstMove()) {
      this.clock = pauseClock(this.clock);
      this.stopTimers();
      this.broadcast({
        type: 'clock',
        whiteTimeMs: this.clock.whiteMs,
        blackTimeMs: this.clock.blackMs,
        paused: this.clock.paused,
      });
    }

    // The disconnected player can't move; the first-move timer should not
    // keep ticking against them.
    if (this.firstMoveTimer) {
      clearTimeout(this.firstMoveTimer);
      this.firstMoveTimer = null;
    }

    // Tell the remaining player(s) the opponent has X seconds to return.
    const deadlineMs = Date.now() + this.graceMs;
    this.broadcast({
      type: 'presence',
      color: m.color,
      connected: false,
      reason: 'disconnected',
      deadlineMs,
    });

    // Start the abandonment timer.
    if (this.abandonmentTimer) clearTimeout(this.abandonmentTimer);
    this.abandonmentTimer = setTimeout(() => {
      // If they're still disconnected after grace, end the game.
      const cur = this.members.get(userId);
      if (!cur || cur.disconnectedAt === null) return;
      if (this.ended) return;
      if (this.hasFirstMove()) {
        // Mid-game abandonment — absent side forfeits.
        const term: Termination =
          userId === this.match.creator_id ? 'creator_abandoned' : 'opponent_abandoned';
        const result: Result = m.color === 'white' ? '0-1' : '1-0';
        void this.endGame(result, term);
      } else {
        // No moves were ever played — abort, refund creator, no rating change.
        void this.endGame('*', 'aborted');
      }
    }, this.graceMs);
  }

  private startTimers(): void {
    if (this.clockBroadcastTimer) return;
    this.clockBroadcastTimer = setInterval(() => {
      this.clock = tickClock(this.clock);
      this.broadcast({
        type: 'clock',
        whiteTimeMs: this.clock.whiteMs,
        blackTimeMs: this.clock.blackMs,
        paused: this.clock.paused,
      });
    }, 1000);

    if (this.flagCheckTimer) return;
    this.flagCheckTimer = setInterval(() => {
      if (hasFlagged(this.clock)) {
        const flagger: Color = this.clock.sideToMove;
        const result: Result = flagger === 'white' ? '0-1' : '1-0';
        void this.endGame(result, 'timeout');
      }
    }, 200);
  }

  private stopTimers(): void {
    if (this.clockBroadcastTimer) {
      clearInterval(this.clockBroadcastTimer);
      this.clockBroadcastTimer = null;
    }
    if (this.flagCheckTimer) {
      clearInterval(this.flagCheckTimer);
      this.flagCheckTimer = null;
    }
  }

  private async endGame(result: Result, termination: Termination): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.stopTimers();
    if (this.abandonmentTimer) {
      clearTimeout(this.abandonmentTimer);
      this.abandonmentTimer = null;
    }
    if (this.waitingTimer) {
      clearTimeout(this.waitingTimer);
      this.waitingTimer = null;
    }
    if (this.firstMoveTimer) {
      clearTimeout(this.firstMoveTimer);
      this.firstMoveTimer = null;
    }

    try {
      await finalizeGame({
        matchId: this.match.id,
        liveGameId: this.liveGame.id,
        result,
        termination,
        whiteTimeMs: this.clock.whiteMs,
        blackTimeMs: this.clock.blackMs,
        finalFen: this.chess.fen(),
        pgn: this.chess.pgn(),
      });
    } catch (err) {
      console.error(`[game-room ${this.match.id}] finalize failed`, err);
    }

    this.broadcast({
      type: 'end',
      result,
      termination,
      whiteTimeMs: this.clock.whiteMs,
      blackTimeMs: this.clock.blackMs,
    });

    // Fire-and-forget settlement; the web side runs the actual ledger transaction.
    void notifySettle({ matchId: this.match.id, result, termination });

    // Give clients a moment to receive the 'end' message, then close out.
    setTimeout(() => {
      for (const m of this.members.values()) {
        try {
          m.socket.close(1000, 'game ended');
        } catch {
          /* ignore */
        }
      }
    }, 1000);
  }
}
