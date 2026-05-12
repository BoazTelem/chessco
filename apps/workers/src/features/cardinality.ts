/**
 * One-shot diagnostic: how many distinct handles do we have in the games
 * corpus, and how many have enough games for meaningful features?
 *
 * Run before features:run to size the work.
 */
import 'dotenv/config';
import { getGamesDb } from '../db';

async function main() {
  const { client } = getGamesDb();
  try {
    const rows = await client<
      { unique_handles: number; handles_ge10: number; handles_ge5: number }[]
    >`
      SELECT
        COUNT(*) AS unique_handles,
        COUNT(*) FILTER (WHERE games_count >= 10) AS handles_ge10,
        COUNT(*) FILTER (WHERE games_count >= 5) AS handles_ge5
      FROM (
        SELECT LOWER(handle) AS handle, COUNT(*) AS games_count
        FROM (
          SELECT white_handle_snapshot AS handle FROM games
            WHERE source = 'lichess' AND white_handle_snapshot IS NOT NULL
          UNION ALL
          SELECT black_handle_snapshot FROM games
            WHERE source = 'lichess' AND black_handle_snapshot IS NOT NULL
        ) u GROUP BY LOWER(handle)
      ) g
    `;
    const r = rows[0];
    console.log('Distinct lichess handles in games:', r?.unique_handles);
    console.log('  with >= 5 games :', r?.handles_ge5);
    console.log('  with >= 10 games:', r?.handles_ge10);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
