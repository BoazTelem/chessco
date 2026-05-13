/**
 * Hourly snapshot of games-corpus counts into Supabase.
 *
 * The crawlers write to games-corpus (Cloud SQL, separate from Supabase).
 * The homepage reads from Supabase via public_index_stats() RPC. This
 * cron bridges the two: every hour at :00, query distinct handles and
 * total games per source from games-corpus, write rows to Supabase
 * corpus_index_counts. The homepage RPC picks up the latest snapshot
 * via ORDER BY snapshot_at DESC LIMIT 1.
 *
 * Cron: 0 * * * *
 * Manual trigger: chessco/corpus-counts.refresh.requested
 */
import { takeCorpusCountsSnapshot } from '../lib/corpus-counts-snapshot.js';
import { inngest } from './client.js';

export const corpusCountsHourly = inngest.createFunction(
  {
    id: 'corpus-counts-hourly',
    name: 'Crawl corpus — hourly handles + games snapshot to Supabase',
    concurrency: { limit: 1 },
    retries: 2,
  },
  [{ cron: '0 * * * *' }, { event: 'chessco/corpus-counts.refresh.requested' }],
  async ({ logger }) => {
    const t0 = Date.now();
    const snapshots = await takeCorpusCountsSnapshot();
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    logger.info(
      `corpus-counts snapshot: chesscom=${snapshots[0]!.distinct_handles} handles ` +
        `/ ${snapshots[0]!.total_games} games · lichess=${snapshots[1]!.distinct_handles} ` +
        `handles / ${snapshots[1]!.total_games} games · ${elapsed}s`,
    );
    return { snapshots };
  },
);
