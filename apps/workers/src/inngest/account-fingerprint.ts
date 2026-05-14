/**
 * On-link fingerprint Inngest functions.
 *
 * Fires when a user verifies a Lichess (OAuth) or chess.com (bio-token) account
 * in the web app. Builds an account_fingerprint via the fast-lane workers so
 * the user already has style data in the corpus by the time the Phase 1 W10
 * "Import your games" surface ships. Skips heavy games/moves/positions writes —
 * those are reserved for the full-lane crawler.
 *
 * Events:
 *   chessco/account.linked.chesscom  { profile_id, handle }
 *   chessco/account.linked.lichess   { profile_id, handle }
 *
 * Concurrency limit 4 means up to 4 fresh links process in parallel; further
 * arrivals queue. Per-handle idempotency key dedupes if the user re-links the
 * same account inside the dedupe window (default 24h in Inngest).
 */
import { inngest } from './client.js';
import { runChesscomFingerprintOne } from '../features/fast-lane.js';
import { runLichessFingerprintOne } from '../features/fast-lane-lichess.js';

export const accountFingerprintChesscom = inngest.createFunction(
  {
    id: 'account-fingerprint-chesscom',
    name: 'Account fingerprint — chess.com (fast-lane on link)',
    concurrency: { limit: 4 },
    retries: 2,
    idempotency: 'event.data.handle',
  },
  { event: 'chessco/account.linked.chesscom' },
  async ({ event, logger }) => {
    const handle = typeof event.data?.handle === 'string' ? event.data.handle.toLowerCase() : null;
    if (!handle) throw new Error('event.data.handle is required');
    logger.info(`fast-lane fingerprint requested: chess.com/${handle}`);
    const r = await runChesscomFingerprintOne(handle);
    logger.info(
      `chess.com/${handle}: games=${r.gamesAccepted}/${r.gamesSeen} ` +
        `wrote=${r.fingerprintWritten} skip=${r.skipReason ?? 'none'} (${r.durationMs}ms)`,
    );
    return r;
  },
);

export const accountFingerprintLichess = inngest.createFunction(
  {
    id: 'account-fingerprint-lichess',
    name: 'Account fingerprint — Lichess (fast-lane on link)',
    concurrency: { limit: 4 },
    retries: 2,
    idempotency: 'event.data.handle',
  },
  { event: 'chessco/account.linked.lichess' },
  async ({ event, logger }) => {
    const handle = typeof event.data?.handle === 'string' ? event.data.handle.toLowerCase() : null;
    if (!handle) throw new Error('event.data.handle is required');
    logger.info(`fast-lane fingerprint requested: lichess/${handle}`);
    const r = await runLichessFingerprintOne(handle);
    logger.info(
      `lichess/${handle}: games=${r.gamesAccepted}/${r.gamesSeen} ` +
        `wrote=${r.fingerprintWritten} skip=${r.skipReason ?? 'none'} (${r.durationMs}ms)`,
    );
    return r;
  },
);

export const accountFingerprintFunctions = [accountFingerprintChesscom, accountFingerprintLichess];
