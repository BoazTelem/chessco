import { createHash } from 'node:crypto';

export interface LeakFingerprintInput {
  platform: 'lichess' | 'chess.com';
  handleNormalized: string;
  userColor: 'white' | 'black';
  kind: 'personalized' | 'surprise';
  fenKey: string;
  userMoveUci: string;
  opponentBadMoveUci: string;
}

const FP_VERSION = 'v1';

export function leakFingerprint(input: LeakFingerprintInput): string {
  const payload = [
    FP_VERSION,
    input.platform,
    input.handleNormalized,
    input.userColor,
    input.kind,
    input.fenKey,
    input.userMoveUci,
    input.opponentBadMoveUci,
  ].join('|');
  return createHash('sha1').update(payload).digest('hex');
}

export function normalizeHandle(handle: string): string {
  return handle.trim().toLowerCase();
}
