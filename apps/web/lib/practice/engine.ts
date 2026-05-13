/**
 * Stockfish engine wrapper. Spawns the stockfish.js Web Worker (served from
 * /stockfish/stockfish.js — manually copy from node_modules/stockfish/src/
 * during setup, or symlink in postinstall) and exposes a promise-based UCI
 * API for one-position-at-a-time analysis.
 *
 * Used by ReviewBoard.tsx to step through a finished game and annotate every
 * move. The instance is shared across the page lifetime; calling .stop()
 * aborts the in-flight search.
 */

const DEFAULT_URL = '/stockfish/stockfish.js';

export interface EvalResult {
  fen: string;
  depth: number;
  cp: number | null; // centipawns from White's POV
  mate: number | null; // mate-in-N from White's POV; positive = White wins
  bestMoveUci: string | null;
}

export class StockfishEngine {
  private worker: Worker | null = null;
  private ready: Promise<void>;
  private resolveReady!: () => void;
  private currentResolve: ((r: EvalResult) => void) | null = null;
  private currentFen: string | null = null;
  private lastInfo: { depth: number; cp: number | null; mate: number | null } = {
    depth: 0,
    cp: null,
    mate: null,
  };

  constructor(workerUrl: string = DEFAULT_URL) {
    this.ready = new Promise((res) => {
      this.resolveReady = res;
    });
    if (typeof window === 'undefined') return;
    try {
      this.worker = new Worker(workerUrl);
      this.worker.onmessage = (e) => this.onMessage(String(e.data));
      this.worker.onerror = (e) => {
        // eslint-disable-next-line no-console
        console.error('[stockfish] worker error', e);
      };
      this.send('uci');
      this.send('isready');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[stockfish] failed to spawn worker', err);
    }
  }

  private send(cmd: string) {
    this.worker?.postMessage(cmd);
  }

  private onMessage(line: string) {
    if (line === 'readyok' || line.startsWith('uciok')) {
      this.resolveReady();
      return;
    }
    if (line.startsWith('info ') && this.currentResolve) {
      const depthMatch = /\bdepth (\d+)\b/.exec(line);
      const cpMatch = /\bscore cp (-?\d+)\b/.exec(line);
      const mateMatch = /\bscore mate (-?\d+)\b/.exec(line);
      if (depthMatch) this.lastInfo.depth = Number(depthMatch[1]);
      this.lastInfo.cp = cpMatch ? Number(cpMatch[1]) : this.lastInfo.cp;
      this.lastInfo.mate = mateMatch ? Number(mateMatch[1]) : this.lastInfo.mate;
      return;
    }
    if (line.startsWith('bestmove ') && this.currentResolve) {
      const match = /^bestmove\s+(\S+)/.exec(line);
      const bestMoveUci = match && match[1] !== '(none)' ? match[1]! : null;
      const fen = this.currentFen!;
      // Convert eval to White's POV. Stockfish reports from the side-to-move's POV.
      const sideToMove = fen.split(' ')[1];
      const sign = sideToMove === 'b' ? -1 : 1;
      const result: EvalResult = {
        fen,
        depth: this.lastInfo.depth,
        cp: this.lastInfo.cp !== null ? sign * this.lastInfo.cp : null,
        mate: this.lastInfo.mate !== null ? sign * this.lastInfo.mate : null,
        bestMoveUci,
      };
      const resolve = this.currentResolve;
      this.currentResolve = null;
      this.currentFen = null;
      this.lastInfo = { depth: 0, cp: null, mate: null };
      resolve(result);
    }
  }

  async whenReady(): Promise<void> {
    return this.ready;
  }

  /**
   * Evaluate one position at fixed depth. Resolves with the engine's verdict
   * (cp from White's POV). Only one analysis at a time per engine instance —
   * subsequent calls queue.
   */
  async evaluate(fen: string, depth = 18): Promise<EvalResult> {
    await this.ready;
    // Serialize: if a search is in flight, wait for it.
    while (this.currentResolve) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return new Promise<EvalResult>((resolve) => {
      this.currentResolve = resolve;
      this.currentFen = fen;
      this.send('ucinewgame');
      this.send(`position fen ${fen}`);
      this.send(`go depth ${depth}`);
    });
  }

  /** Abort any in-flight search and clean up. */
  stop(): void {
    this.send('stop');
    this.worker?.terminate();
    this.worker = null;
    this.currentResolve = null;
  }
}

/** Classify a move by centipawn loss vs the engine's preferred line. */
export type Annotation = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';
export function annotateCpLoss(loss: number): Annotation {
  if (loss < 20) return 'best';
  if (loss < 50) return 'good';
  if (loss < 100) return 'inaccuracy';
  if (loss < 300) return 'mistake';
  return 'blunder';
}
