/**
 * Crawl-refresh cron functions.
 *
 * The chess.com and Lichess per-handle crawlers run continuously as
 * PowerShell loops on the user's two Windows machines. They drain
 * whatever the queue holds. These cron functions don't talk to the
 * workers — they just rewrite queue state, flipping `done` rows back
 * to `pending` once their 7-day TTL has elapsed. Workers pick them up
 * on their next iteration automatically.
 *
 * Three functions:
 *   - crawl-refresh-chesscom  04:00 UTC daily
 *   - crawl-refresh-lichess   05:00 UTC daily
 *   - lichess-monthly-discovery   1st of month, 02:00 UTC — fresh-month
 *     dump scan to catch new active players that joined since last scan
 *
 * Each is also triggerable manually via Inngest sendEvent for ops use.
 */
import { getGamesDb } from '../db.js';
import { refreshStaleChesscom } from '../chesscom-crawl/refresh-stale.js';
import { refreshStaleLichess } from '../lichess-crawl/refresh-stale.js';
import { inngest } from './client.js';

export const crawlRefreshChesscom = inngest.createFunction(
  {
    id: 'crawl-refresh-chesscom',
    name: 'Chess.com crawl — daily refresh of stale archive_month rows',
    concurrency: { limit: 1 },
    retries: 2,
  },
  [{ cron: '0 4 * * *' }, { event: 'chessco/chesscom-crawl.refresh.requested' }],
  async ({ logger }) => {
    const { client } = getGamesDb();
    try {
      const t0 = Date.now();
      const r = await refreshStaleChesscom(client);
      logger.info(
        `chess.com refresh re-queued ${r.rowsRequeued.toLocaleString()} rows ` +
          `in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
      return r;
    } finally {
      await client.end();
    }
  },
);

export const crawlRefreshLichess = inngest.createFunction(
  {
    id: 'crawl-refresh-lichess',
    name: 'Lichess crawl — daily refresh of stale handle rows',
    concurrency: { limit: 1 },
    retries: 2,
  },
  [{ cron: '0 5 * * *' }, { event: 'chessco/lichess-crawl.refresh.requested' }],
  async ({ logger }) => {
    const { client } = getGamesDb();
    try {
      const t0 = Date.now();
      const r = await refreshStaleLichess(client);
      logger.info(
        `lichess refresh re-queued ${r.rowsRequeued.toLocaleString()} rows ` +
          `in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
      return r;
    } finally {
      await client.end();
    }
  },
);

export const crawlRefreshFunctions = [crawlRefreshChesscom, crawlRefreshLichess];
