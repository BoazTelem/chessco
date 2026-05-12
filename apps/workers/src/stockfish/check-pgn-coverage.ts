/** Quick survey: how many games have a non-empty pgn, broken down by source. */
import 'dotenv/config';
import { getGamesDb } from '../db';

async function main() {
  const { client } = getGamesDb();
  const rows = await client<
    { source: string; total: string; with_pgn: string; with_moves: string }[]
  >`
    SELECT source,
           COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE length(pgn) > 0)::text AS with_pgn,
           COUNT(*) FILTER (WHERE ply_count > 0)::text AS with_moves
    FROM games
    GROUP BY source
    ORDER BY source
  `;
  console.table(rows);
  await client.end({ timeout: 5 });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
