/// <reference lib="webworker" />

import { parsePgn } from './parse-pgn';
import type { TimeClass } from './types';

interface WorkerRequest {
  id: number;
  pgn: string;
  targetHandle: string;
  fallbackId: string;
  playedAt: Date;
  timeClass: TimeClass;
}

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, pgn, targetHandle, fallbackId, playedAt, timeClass } = event.data;
  try {
    const game = parsePgn(pgn, {
      targetHandle,
      fallbackId,
      playedAtOverride: playedAt,
      timeClassOverride: timeClass,
    });
    self.postMessage({ id, game });
  } catch {
    // A single malformed PGN must not kill the worker — uncaught throws here
    // bubble to the parent's onerror and reject every in-flight parse.
    self.postMessage({ id, game: null });
  }
};

export {};
