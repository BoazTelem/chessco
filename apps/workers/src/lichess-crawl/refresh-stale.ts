/**
 * Re-queue any lichess_crawl_queue rows whose next_refresh_at has passed.
 * Workers running on the loop script pick them up automatically on their
 * next claim cycle.
 *
 * Idempotent: rows already pending are not touched. Only `done` rows
 * with `next_refresh_at < NOW()` are flipped back.
 *
 * Usage:
 *   pnpm --filter @chessco/workers lichess:crawl:refresh
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { getGamesDb } from '../db';

export interface RefreshResult {
  rowsRequeued: number;
}

export async function refreshStaleLichess(sql: postgres.Sql): Promise<RefreshResult> {
  // Backfill: rows that were marked done before migration 0006 have a
  // NULL next_refresh_at. Give them a TTL based on when they finished.
  // Idempotent (NULL-only update), runs once meaningfully then no-ops.
  await sql`
    UPDATE lichess_crawl_queue
    SET next_refresh_at = completed_at + INTERVAL '7 days'
    WHERE status = 'done'
      AND next_refresh_at IS NULL
      AND completed_at IS NOT NULL
  `;

  const result = await sql<{ id: string }[]>`
    UPDATE lichess_crawl_queue
    SET status = 'pending',
        claimed_at = NULL,
        attempts = 0,
        last_error = NULL,
        next_attempt_at = NOW()
    WHERE status = 'done'
      AND next_refresh_at IS NOT NULL
      AND next_refresh_at <= NOW()
    RETURNING id
  `;
  return { rowsRequeued: result.length };
}

async function main() {
  const { client } = getGamesDb();
  try {
    const r = await refreshStaleLichess(client);
    console.log(`[lichess:crawl:refresh] re-queued ${r.rowsRequeued.toLocaleString()} stale rows`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

// Run main() when invoked directly as a CLI; skip when imported by the
// Inngest function (which calls refreshStaleLichess() in-process).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('lichess:crawl:refresh failed:', err);
    process.exit(1);
  });
}
