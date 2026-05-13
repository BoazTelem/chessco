/**
 * One-shot: bump existing archive_month queue rows to priority=10 so the
 * workers preferentially drain them over the leftover archives_list backlog.
 *
 * Without this, the FIFO id order keeps workers stuck in archives_list
 * expansion (which produces zero games) until that pool drains. Bumping
 * priority makes archive_month rows jump the line.
 *
 * Safe to re-run — idempotent.
 */
import 'dotenv/config';
import { getGamesDb } from '../db';

async function main() {
  const { client } = getGamesDb();
  try {
    const before = await client<{ kind: string; priority: number; n: string }[]>`
      SELECT kind, priority, COUNT(*)::text AS n
      FROM chesscom_crawl_queue
      WHERE status IN ('pending', 'error_retry')
      GROUP BY kind, priority
      ORDER BY kind, priority
    `;
    console.log('--- before ---');
    for (const r of before) console.log(`  ${r.kind} priority=${r.priority}: ${r.n}`);

    const updated = await client<{ id: string }[]>`
      UPDATE chesscom_crawl_queue
      SET priority = 10
      WHERE kind = 'archive_month'
        AND status IN ('pending', 'error_retry')
        AND priority < 10
      RETURNING id
    `;
    console.log(`\nbumped ${updated.length.toLocaleString()} archive_month rows to priority=10`);

    const after = await client<{ kind: string; priority: number; n: string }[]>`
      SELECT kind, priority, COUNT(*)::text AS n
      FROM chesscom_crawl_queue
      WHERE status IN ('pending', 'error_retry')
      GROUP BY kind, priority
      ORDER BY kind, priority
    `;
    console.log('\n--- after ---');
    for (const r of after) console.log(`  ${r.kind} priority=${r.priority}: ${r.n}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
