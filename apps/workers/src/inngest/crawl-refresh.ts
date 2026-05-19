/**
 * Crawl-refresh cron — chess.com only.
 *
 * Flips chesscom_crawl_queue rows from 'done' back to 'pending' once their
 * 7-day TTL has elapsed so the Cloud Run crawlers re-pull fresh games.
 *
 * Lichess intentionally has no refresh cron: per
 * [docs/INCIDENT-2026-05-18-lichess-ip-block.md], the per-handle
 * /api/games/user/ enumeration is forbidden. Lichess refresh happens
 * implicitly via the monthly dump (apps/workers/src/lichess-dumps/).
 *
 * Cron: 04:00 UTC daily. Manually triggerable via Inngest event.
 */
import { getGamesDb } from '../db.js';
import { refreshStaleChesscom } from '../chesscom-crawl/refresh-stale.js';
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

export const crawlRefreshFunctions = [crawlRefreshChesscom];
