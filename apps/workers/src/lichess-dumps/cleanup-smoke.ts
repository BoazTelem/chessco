/**
 * Remove fixture rows left over from ingest-smoke (handles 'alice'/'bob'/
 * 'carla'/'dave'). Used to leave Cloud SQL clean before the first real run.
 */
import 'dotenv/config';
import { getGamesDb } from '../db';

async function main() {
  const { client } = getGamesDb();
  try {
    const fixtureIds = ['abcdefgh', '11223344'];
    const moves = await client`
      DELETE FROM moves WHERE game_id IN (
        SELECT id FROM games WHERE source = 'lichess' AND source_game_id IN ${client(fixtureIds)}
      )
    `;
    const games = await client`
      DELETE FROM games WHERE source = 'lichess' AND source_game_id IN ${client(fixtureIds)}
    `;
    console.log(`deleted moves: ${moves.count}, games: ${games.count}`);

    // Positions intentionally left — they're shared by FEN content, harmless.
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('cleanup failed:', err);
  process.exit(1);
});
