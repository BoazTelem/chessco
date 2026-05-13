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
  const game = parsePgn(pgn, {
    targetHandle,
    fallbackId,
    playedAtOverride: playedAt,
    timeClassOverride: timeClass,
  });
  self.postMessage({ id, game });
};

export {};
