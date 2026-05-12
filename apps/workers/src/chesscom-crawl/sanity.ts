import 'dotenv/config';
import { getGamesDb } from '../db';

async function main() {
  const { client } = getGamesDb();
  try {
    const queue = await client<{ status: string; count: string }[]>`
      SELECT status, COUNT(*)::text AS count FROM chesscom_crawl_queue
      GROUP BY status ORDER BY status
    `;
    const games = await client<{ source: string; n: string }[]>`
      SELECT source, COUNT(*)::text AS n FROM games GROUP BY source ORDER BY source
    `;
    const runs = await client<
      {
        id: string;
        worker_id: string;
        status: string;
        items_processed: number;
        games_inserted: number;
        errors: number;
        ago: string;
      }[]
    >`
      SELECT id, worker_id, status, items_processed, games_inserted, errors,
             (NOW() - last_heartbeat_at)::text AS ago
      FROM chesscom_crawl_runs ORDER BY started_at DESC LIMIT 5
    `;
    const sample = await client<
      {
        source_game_id: string;
        white_handle_snapshot: string;
        black_handle_snapshot: string;
        time_class: string;
        result: string;
        played_at: string;
      }[]
    >`
      SELECT source_game_id, white_handle_snapshot, black_handle_snapshot,
             time_class, result, played_at::text
      FROM games WHERE source = 'chess.com'
      ORDER BY imported_at DESC LIMIT 5
    `;
    const distinctHandles = await client<{ n: string }[]>`
      SELECT COUNT(DISTINCT lower_h)::text AS n FROM (
        SELECT LOWER(white_handle_snapshot) AS lower_h FROM games
        WHERE source = 'chess.com' AND white_handle_snapshot IS NOT NULL
        UNION
        SELECT LOWER(black_handle_snapshot) FROM games
        WHERE source = 'chess.com' AND black_handle_snapshot IS NOT NULL
      ) t
    `;

    console.log('--- queue status ---');
    for (const r of queue) console.log(`  ${r.status.padEnd(18)} ${r.count}`);
    console.log('\n--- games by source ---');
    for (const r of games) console.log(`  ${r.source.padEnd(12)} ${r.n}`);
    console.log(`  distinct chess.com handles seen: ${distinctHandles[0]!.n}`);
    console.log('\n--- last 5 crawl runs ---');
    for (const r of runs) {
      console.log(
        `  run #${r.id}: ${r.status.padEnd(8)} items=${r.items_processed} ` +
          `games=${r.games_inserted} errors=${r.errors} hb_ago=${r.ago}`,
      );
    }
    console.log('\n--- 5 most recent chess.com games ---');
    for (const r of sample) {
      console.log(
        `  ${r.played_at}  ${r.source_game_id.padEnd(38)}  ` +
          `${(r.white_handle_snapshot ?? '?').padEnd(20)} vs ${(r.black_handle_snapshot ?? '?').padEnd(20)} ` +
          `${r.time_class}  ${r.result}`,
      );
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
