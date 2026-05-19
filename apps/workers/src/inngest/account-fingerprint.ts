/**
 * On-link account-import pipeline.
 *
 * Fires when a user verifies a Lichess (OAuth) or chess.com (bio-token) account
 * in the web app. Per-platform behavior differs because of policy:
 *
 *   chess.com  →  fast-lane fingerprint (single API call) + full-lane crawl
 *                 seed (chesscom_crawl_queue at ON_DEMAND priority + watchdog
 *                 kick). The crawler then ingests the user's games for the
 *                 corpus; account-import-poll builds player_repertoires.
 *
 *   lichess    →  fast-lane fingerprint (single API call) only. No queue seed,
 *                 no crawler kick — per [docs/INCIDENT-2026-05-18-lichess-ip-block.md]
 *                 looping through handles via /api/games/user/ is forbidden by
 *                 Lichess. The user's games arrive in the corpus via the next
 *                 monthly dump scan. Single-user fingerprint is still allowed.
 *
 * Events:
 *   chessco/account.linked.chesscom  { profile_id, handle }
 *   chessco/account.linked.lichess   { profile_id, handle }
 */
import { getGamesDb } from '../db.js';
import { seedHandles as seedChesscomHandles } from '../chesscom-crawl/queue.js';
import { runChesscomFingerprintOne } from '../features/fast-lane.js';
import { runLichessFingerprintOne } from '../features/lichess-fingerprint-one.js';
import { inngest } from './client.js';

const ON_DEMAND_CRAWL_PRIORITY = 100;

async function seedChesscomFullLaneAndKick(
  handle: string,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<{ seeded: number; watchdog: 'fired' | 'failed' }> {
  const { client } = getGamesDb();
  let seeded = 0;
  try {
    seeded = await seedChesscomHandles(client, [handle], ON_DEMAND_CRAWL_PRIORITY);
    logger.info(
      `[account-import] chess.com/${handle}: full-lane seed ${seeded === 1 ? 'new' : 'already queued'}`,
    );
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }

  let watchdog: 'fired' | 'failed' = 'fired';
  try {
    await inngest.send({ name: 'chessco/crawler-watchdog.run.requested', data: {} });
  } catch (err) {
    watchdog = 'failed';
    logger.warn(
      `[account-import] chess.com/${handle}: watchdog kick failed — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { seeded, watchdog };
}

export const accountFingerprintChesscom = inngest.createFunction(
  {
    id: 'account-fingerprint-chesscom',
    name: 'Account import — chess.com (fingerprint + full-lane seed)',
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
    const k = await seedChesscomFullLaneAndKick(handle, logger);
    return { ...r, fullLane: k };
  },
);

export const accountFingerprintLichess = inngest.createFunction(
  {
    id: 'account-fingerprint-lichess',
    name: 'Account import — Lichess (fingerprint only; corpus via monthly dump)',
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
        `wrote=${r.fingerprintWritten} skip=${r.skipReason ?? 'none'} (${r.durationMs}ms); ` +
        `corpus games arrive via next monthly dump`,
    );
    return {
      ...r,
      fullLane: { seeded: 0, watchdog: 'fired' as const, note: 'lichess-uses-dumps' },
    };
  },
);

export const accountFingerprintFunctions = [accountFingerprintChesscom, accountFingerprintLichess];
