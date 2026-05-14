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
        completed_at: string | null;
        last_error: string | null;
      }[]
    >`
      SELECT id, handle, kind, archive_url, attempts, completed_at::text, last_error
      FROM chesscom_crawl_queue
      WHERE status = 'error_permanent'
      ORDER BY completed_at DESC NULLS LAST
    `;
    console.log(`error_permanent rows: ${rows.length}`);
    for (const r of rows) {
      console.log('---');
      console.log(`  id=${r.id} handle=${r.handle} kind=${r.kind}`);
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
