/**
 * On-link account-import pipeline (fast-lane + full-lane).
 *
 * Fires when a user verifies a Lichess (OAuth) or chess.com (bio-token) account
 * in the web app. Two things happen per link:
 *
 *   1. fast-lane fingerprint — builds account_fingerprints + style_features
 *      inline (no games/moves/positions writes). Cheap; gives the corpus this
 *      account's style data immediately so scout/search work right away.
 *
 *   2. full-lane crawl seed — enqueues the handle into chesscom_crawl_queue /
 *      lichess_crawl_queue at ON_DEMAND priority, then fires the watchdog
 *      event so a Cloud Run crawler boots within ~30s instead of waiting up
 *      to 15min for the watchdog cron. Once the crawler ingests the user's
 *      games, account-import-poll picks them up and builds their personal
 *      player_repertoires tree.
 *
 * Events:
 *   chessco/account.linked.chesscom  { profile_id, handle }
 *   chessco/account.linked.lichess   { profile_id, handle }
 *
 * Concurrency limit 4 means up to 4 fresh links process in parallel; further
 * arrivals queue. Per-handle idempotency key dedupes if the user re-links the
 * same account inside the dedupe window (default 24h in Inngest).
 */
import { getGamesDb } from '../db.js';
import { seedHandles as seedChesscomHandles } from '../chesscom-crawl/queue.js';
import { seedHandles as seedLichessHandles } from '../lichess-crawl/queue.js';
import { runChesscomFingerprintOne } from '../features/fast-lane.js';
import { runLichessFingerprintOne } from '../features/fast-lane-lichess.js';
import { inngest } from './client.js';

// Priority floor matches prepare-reports.ts ON_DEMAND_CRAWL_PRIORITY — a
// linked user is a real human waiting for their tree, so they jump ahead of
// the bulk seed (priority 0) but below any future premium tier (>=200).
const ON_DEMAND_CRAWL_PRIORITY = 100;

async function seedFullLaneAndKick(
  platform: 'chess.com' | 'lichess',
  handle: string,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<{ seeded: number; watchdog: 'fired' | 'failed' }> {
  const { client } = getGamesDb();
  let seeded = 0;
  try {
    if (platform === 'chess.com') {
      seeded = await seedChesscomHandles(client, [handle], ON_DEMAND_CRAWL_PRIORITY);
    } else {
      seeded = await seedLichessHandles(client, [handle], ON_DEMAND_CRAWL_PRIORITY);
    }
    logger.info(
      `[account-import] ${platform}/${handle}: full-lane seed ${seeded === 1 ? 'new' : 'already queued'}`,
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
      `[account-import] ${platform}/${handle}: watchdog kick failed — ` +
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
    const k = await seedFullLaneAndKick('chess.com', handle, logger);
    return { ...r, fullLane: k };
  },
);

export const accountFingerprintLichess = inngest.createFunction(
  {
    id: 'account-fingerprint-lichess',
    name: 'Account import — Lichess (fingerprint + full-lane seed)',
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
    const k = await seedFullLaneAndKick('lichess', handle, logger);
    return { ...r, fullLane: k };
  },
);

export const accountFingerprintFunctions = [accountFingerprintChesscom, accountFingerprintLichess];
