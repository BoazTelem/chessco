/**
 * One-shot: reset Lichess queue rows that hit the 'terminated' stream
 * error back to pending so they retry with the per-quarter request
 * chunking (REQUEST_CHUNKS=4 in run.ts).
 *
 * Targets both error_permanent (5×retry exhausted) and error_retry
 * (still mid-retry). Idempotent.
 *
 * Usage: tsx src/lichess-crawl/reset-terminated.ts
 */
import 'dotenv/config';
import { getGamesDb } from '../db';

async function main() {
  const { client } = getGamesDb();
  try {
    const r = await client<{ id: string; handle: string; status: string }[]>`
      UPDATE lichess_crawl_queue
      SET status = 'pending',
          attempts = 0,
          claimed_at = NULL,
          next_attempt_at = NOW(),
          last_error = NULL
      WHERE status IN ('error_permanent', 'error_retry')
        AND last_error LIKE '%terminated%'
      RETURNING id, handle, status
    `;
    console.log(`reset ${r.length} 'terminated' rows back to pending`);
    for (const row of r) console.log(`  ${row.handle} (was ${row.status})`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('reset-terminated failed:', err);
  process.exit(1);
});
