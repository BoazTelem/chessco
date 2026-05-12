/**
 * Pretty-print a single handle's feature vector.
 *   pnpm --filter @chessco/workers features:inspect lichess savinka59
 */
import 'dotenv/config';
import { getGamesDb } from '../db';

async function main() {
  const [platform, handle] = process.argv.slice(2);
  if (!platform || !handle) {
    throw new Error('Usage: features:inspect <platform> <handle>');
  }
  const { client } = getGamesDb();
  try {
    const rows = await client<
      {
        id: string;
        games_seen: number;
        features: unknown;
        games_window: number;
        computed_at: string;
      }[]
    >`
      SELECT h.id, h.games_seen, sf.features, sf.games_window, sf.computed_at::text
      FROM handles h
      LEFT JOIN style_features sf ON sf.player_id = h.id
      WHERE h.platform = ${platform} AND h.handle = ${handle.toLowerCase()}
    `;
    if (rows.length === 0) {
      console.log(`no row for ${platform}/${handle}`);
      return;
    }
    const r = rows[0]!;
    console.log(`handle id     : ${r.id}`);
    console.log(`games_seen    : ${r.games_seen}`);
    console.log(`games_window  : ${r.games_window}`);
    console.log(`computed_at   : ${r.computed_at}`);
    console.log('features      :');
    console.log(JSON.stringify(r.features, null, 2));
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
