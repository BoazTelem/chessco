/**
 * Re-queue any chesscom_crawl_queue archive_month rows whose
 * next_refresh_at has passed. Workers running on the loop scripts
 * pick them up automatically on their next claim cycle.
 *
 * Exposed as both a CLI (for manual runs / cron-on-Task-Scheduler)
 * and an exported function so the Inngest cron wrapper can call it
 * in-process.
 *
 * Idempotent: rows already pending are not touched. Only `done` rows
 * with `next_refresh_at < NOW()` are flipped back.
 *
 * Usage:
 *   pnpm --filter @chessco/workers chesscom:crawl:refresh
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { getGamesDb } from '../db';

export interface RefreshResult {
  rowsRequeued: number;
}

export async function refreshStaleChesscom(sql: postgres.Sql): Promise<RefreshResult> {
  // Backfill: rows that were marked done before migration 0006 have a
  // NULL next_refresh_at. Give them a TTL based on when they finished.
  // Idempotent (NULL-only update), runs once meaningfully then no-ops.
  await sql`
    UPDATE chesscom_crawl_queue
    SET next_refresh_at = completed_at + INTERVAL '7 days'
    WHERE status = 'done'
      AND kind = 'archive_month'
      AND next_refresh_at IS NULL
      AND completed_at IS NOT NULL
  `;

  // Only refresh archive_month rows. archives_list is one-shot discovery
  // (we already enumerated all the months); refreshing those would re-list
  // archive URLs we already have.
  const result = await sql<{ id: string }[]>`
    UPDATE chesscom_crawl_queue
    SET status = 'pending',
        claimed_at = NULL,
        attempts = 0,
        last_error = NULL,
        next_attempt_at = NOW()
    WHERE status = 'done'
      AND kind = 'archive_month'
      AND next_refresh_at IS NOT NULL
      AND next_refresh_at <= NOW()
    RETURNING id
  `;
  return { rowsRequeued: result.length };
}

async function main() {
  const { client } = getGamesDb();
  try {
    const r = await refreshStaleChesscom(client);
    console.log(`[chesscom:crawl:refresh] re-queued ${r.rowsRequeued.toLocaleString()} stale rows`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

// Run main() when invoked directly as a CLI; skip when imported by the
// Inngest function (which calls refreshStaleChesscom() in-process).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('chesscom:crawl:refresh failed:', err);
    process.exit(1);
  });
}
