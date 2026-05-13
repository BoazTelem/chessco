/**
 * Authoritative clocks. Parses time-control strings like "5+0", "3+2", "10+0"
 * (`base+increment` in minutes / seconds). Server tracks elapsed time per
 * side; the side-to-move's clock counts down between server-validated moves.
 */

export interface ClockState {
  whiteMs: number;
  blackMs: number;
  incrementMs: number;
  lastTickAt: number; // ms timestamp (Date.now) of the last clock update
  sideToMove: 'white' | 'black';
  paused: boolean;
}

export function parseTimeControl(tc: string): { baseMs: number; incrementMs: number } {
  const m = /^(\d+)\+(\d+)$/.exec(tc.trim());
  if (!m) throw new Error(`Invalid time control: ${tc}`);
  const baseMin = Number(m[1]);
  const incSec = Number(m[2]);
  return { baseMs: baseMin * 60_000, incrementMs: incSec * 1000 };
}

export function makeClock(tc: string, sideToMove: 'white' | 'black'): ClockState {
  const { baseMs, incrementMs } = parseTimeControl(tc);
  return {
    whiteMs: baseMs,
    blackMs: baseMs,
    incrementMs,
    lastTickAt: Date.now(),
    sideToMove,
    paused: true, // unpause on first move (chess.com convention: clock starts ticking after move 1)
  };
}

/** Subtract elapsed time from the side-to-move's clock; returns updated state. */
export function tick(clock: ClockState, nowMs = Date.now()): ClockState {
  if (clock.paused) {
    return { ...clock, lastTickAt: nowMs };
  }
  const elapsed = Math.max(0, nowMs - clock.lastTickAt);
  if (clock.sideToMove === 'white') {
    return { ...clock, whiteMs: Math.max(0, clock.whiteMs - elapsed), lastTickAt: nowMs };
  }
  return { ...clock, blackMs: Math.max(0, clock.blackMs - elapsed), lastTickAt: nowMs };
}

/**
 * Apply a successful move: tick down the mover's remaining time, add the
 * increment, flip side-to-move. Unpauses the clock if it was paused (first move).
 */
export function applyMove(clock: ClockState, nowMs = Date.now()): ClockState {
  const ticked = tick(clock, nowMs);
  const mover = ticked.sideToMove;
  const next: ClockState = {
    ...ticked,
    paused: false,
    sideToMove: mover === 'white' ? 'black' : 'white',
  };
  if (mover === 'white') next.whiteMs = ticked.whiteMs + ticked.incrementMs;
  else next.blackMs = ticked.blackMs + ticked.incrementMs;
  return next;
}

/** Check whether the side-to-move has flagged. */
export function hasFlagged(clock: ClockState, nowMs = Date.now()): boolean {
  if (clock.paused) return false;
  const ticked = tick(clock, nowMs);
  return ticked.sideToMove === 'white' ? ticked.whiteMs <= 0 : ticked.blackMs <= 0;
}

/** Pause the clock (used during disconnect grace) without losing elapsed time. */
export function pause(clock: ClockState, nowMs = Date.now()): ClockState {
  const ticked = tick(clock, nowMs);
  return { ...ticked, paused: true };
}

export function resume(clock: ClockState, nowMs = Date.now()): ClockState {
  return { ...clock, paused: false, lastTickAt: nowMs };
}
