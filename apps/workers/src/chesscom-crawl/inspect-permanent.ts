/**
 * One-shot diagnostic: dump every error_permanent row's failure
 * signature so we can decide between auto-reset and code fix.
 *
 * Usage: tsx src/chesscom-crawl/inspect-permanent.ts
 */
import 'dotenv/config';
import { getGamesDb } from '../db';

async function main() {
  const { client } = getGamesDb();
  try {
    const rows = await client<
      {
        id: string;
        handle: string;
        kind: string;
        archive_url: string | null;
        attempts: number;
        status: string;
        completed_at: string | null;
        last_error: string | null;
      }[]
    >`
      SELECT id, handle, kind, archive_url, attempts, status, completed_at::text, last_error
      FROM chesscom_crawl_queue
      WHERE status IN ('error_permanent', 'error_retry')
      ORDER BY status DESC, completed_at DESC NULLS LAST
      LIMIT 20
    `;
    console.log(`error rows (permanent + recent retry): ${rows.length}`);
    for (const r of rows) {
      console.log('---');
      console.log(`  id=${r.id} status=${r.status} handle=${r.handle} kind=${r.kind}`);
      if (r.archive_url) console.log(`  url=${r.archive_url}`);
      console.log(`  attempts=${r.attempts}  completed_at=${r.completed_at ?? '-'}`);
      console.log(`  last_error: ${r.last_error?.slice(0, 500) ?? '(none)'}`);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
