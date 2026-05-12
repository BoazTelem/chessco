import 'dotenv/config';
import { getGamesDb } from '../db';

async function main() {
  const { client } = getGamesDb();
  try {
    const counts = await client<{ tbl: string; n: bigint }[]>`
      SELECT 'games' AS tbl, COUNT(*) AS n FROM games WHERE source = 'lichess'
      UNION ALL SELECT 'moves', COUNT(*) FROM moves
      UNION ALL SELECT 'positions', COUNT(*) FROM positions
      UNION ALL SELECT 'lichess_dump_runs', COUNT(*) FROM lichess_dump_runs
    `;
    for (const c of counts) console.log(`  ${c.tbl.padEnd(20)}: ${c.n.toLocaleString()}`);

    const sample = await client<
      {
        source_game_id: string;
        white_handle_snapshot: string;
        black_handle_snapshot: string;
        white_rating: number;
        black_rating: number;
        result: string;
        time_class: string;
        played_at: string;
      }[]
    >`
      SELECT source_game_id, white_handle_snapshot, black_handle_snapshot,
             white_rating, black_rating, result, time_class, played_at::text
      FROM games
      WHERE source = 'lichess'
      ORDER BY random()
      LIMIT 5
    `;
    console.log('\nRandom 5 games:');
    for (const g of sample) {
      console.log(
        `  · ${g.source_game_id} ${g.white_handle_snapshot}(${g.white_rating}) vs ` +
          `${g.black_handle_snapshot}(${g.black_rating}) ${g.result} ` +
          `${g.time_class} ${g.played_at}`,
      );
    }

    const runs = await client<
      {
        dump_id: string;
        status: string;
        games_seen: bigint;
        games_filtered_in: bigint;
        positions_inserted: bigint;
        moves_inserted: bigint;
      }[]
    >`
      SELECT dump_id, status, games_seen, games_filtered_in, positions_inserted, moves_inserted
      FROM lichess_dump_runs ORDER BY started_at
    `;
    console.log('\nDump runs:');
    for (const r of runs) {
      console.log(
        `  · ${r.dump_id} [${r.status}]  seen=${r.games_seen} accepted=${r.games_filtered_in} ` +
          `positions=${r.positions_inserted} moves=${r.moves_inserted}`,
      );
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('verify failed:', err);
  process.exit(1);
});
