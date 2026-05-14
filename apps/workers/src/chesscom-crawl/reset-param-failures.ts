/**
 * One-shot: reset chesscom_crawl_queue rows that hit the
 * MAX_PARAMETERS_EXCEEDED ceiling back to pending so they retry
 * after the enqueueOpponents chunking fix lands.
 *
 * Idempotent. Safe to re-run. Targets only rows with the specific
 * last_error signature so unrelated permanent failures stay put.
 *
 * Usage: tsx src/chesscom-crawl/reset-param-failures.ts
 */
import 'dotenv/config';
import { getGamesDb } from '../db';

async function main() {
  const { client } = getGamesDb();
  try {
    const r = await client<{ id: string; handle: string; archive_url: string }[]>`
      UPDATE chesscom_crawl_queue
      SET status = 'pending',
          attempts = 0,
          claimed_at = NULL,
          next_attempt_at = NOW(),
          last_error = NULL
      WHERE status = 'error_permanent'
        AND last_error LIKE '%MAX_PARAMETERS_EXCEEDED%'
      RETURNING id, handle, archive_url
    `;
    console.log(`reset ${r.length} param-ceiling failures back to pending`);
    for (const row of r) console.log(`  ${row.handle} ${row.archive_url}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('reset-param-failures failed:', err);
  process.exit(1);
});
