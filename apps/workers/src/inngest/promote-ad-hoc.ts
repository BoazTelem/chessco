/**
 * Inngest wrapper for the promote-ad-hoc worker.
 *
 * Cron: 30 4 * * * UTC (~30 min after FIDE / federation refreshes complete
 *                       so the FIDE-duplicate check uses the latest data).
 * Manual trigger: chessco/promote-ad-hoc.requested
 */
import { getDb } from '../db.js';
import { promoteAdHocPlayers } from '../identification/promote-ad-hoc.js';
import { inngest } from './client.js';

export const promoteAdHocNightly = inngest.createFunction(
  {
    id: 'promote-ad-hoc-nightly',
    name: 'Ad-hoc players — community-confirmed promotion pass',
    concurrency: { limit: 1 },
    retries: 2,
  },
  [{ cron: '30 4 * * *' }, { event: 'chessco/promote-ad-hoc.requested' }],
  async ({ logger }) => {
    const { client } = getDb();
    try {
      const t0 = Date.now();
      const r = await promoteAdHocPlayers(client, { limit: 500 });
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      logger.info(
        `promote-ad-hoc: scanned=${r.scanned} promoted=${r.promoted} ` +
          `dup_fide=${r.duplicates_of_fide} skipped_low=${r.skipped_insufficient_confirmers} ` +
          `skipped_no_handle=${r.skipped_no_handle} · ${elapsed}s`,
      );
      return r;
    } finally {
      await client.end({ timeout: 5 });
    }
  },
);
