import { parsePgn } from './parse-pgn';
import type { GameRecord, TimeClass } from './types';

export interface ParseRequest {
  pgn: string;
  targetHandle: string;
  fallbackId: string;
  playedAt: Date;
  timeClass: TimeClass;
}

interface PendingResolver {
  resolve: (value: GameRecord | null) => void;
  reject: (reason: unknown) => void;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, PendingResolver>();
let workerFailed = false;

function ensureWorker(): Worker | null {
  if (workerFailed) return null;
  if (worker) return worker;
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return null;
  try {
    const w = new Worker(new URL('./parse-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (event: MessageEvent<{ id: number; game: GameRecord | null }>) => {
      const { id, game } = event.data;
      const resolver = pending.get(id);
      if (!resolver) return;
      pending.delete(id);
      resolver.resolve(
        game
          ? {
              ...game,
              playedAt:
                game.playedAt instanceof Date
                  ? game.playedAt
                  : new Date(game.playedAt as unknown as string),
            }
          : null,
      );
    };
    w.onerror = (e) => {
      workerFailed = true;
      worker = null;
      for (const resolver of pending.values()) resolver.reject(e.message ?? 'worker error');
      pending.clear();
    };
    worker = w;
    return w;
  } catch {
    workerFailed = true;
    return null;
  }
}

export function parseGameOffThread(req: ParseRequest): Promise<GameRecord | null> {
  const w = ensureWorker();
  if (!w) {
    // Fallback: parse on the calling thread.
    return Promise.resolve(
      parsePgn(req.pgn, {
        targetHandle: req.targetHandle,
        fallbackId: req.fallbackId,
        playedAtOverride: req.playedAt,
        timeClassOverride: req.timeClass,
      }),
    );
  }
  return new Promise<GameRecord | null>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    w.postMessage({
      id,
      pgn: req.pgn,
      targetHandle: req.targetHandle,
      fallbackId: req.fallbackId,
      playedAt: req.playedAt,
      timeClass: req.timeClass,
    });
  });
}

export function terminateParseWorker(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  for (const resolver of pending.values()) resolver.resolve(null);
  pending.clear();
  workerFailed = false;
  nextId = 1;
}
