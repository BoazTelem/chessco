/**
 * Show the top-N handles by game count after a features run.
 * Useful spot-check to confirm features look sensible at scale.
 */
import 'dotenv/config';
import { getGamesDb } from '../db';

async function main() {
  const { client } = getGamesDb();
  try {
    const rows = await client<
      {
        handle: string;
        games_window: number;
        games_total: number;
        avg_ply: number;
        avg_opp: number | null;
        top_eco_white: string | null;
        top_eco_black: string | null;
        top_time_class: string | null;
      }[]
    >`
      WITH ranked AS (
        SELECT
          h.handle,
          sf.games_window,
          (sf.features->>'games_total')::int AS games_total,
          (sf.features->>'avg_ply_count')::numeric AS avg_ply,
          NULLIF(sf.features->>'avg_opponent_rating', '')::numeric AS avg_opp,
          sf.features
        FROM style_features sf
        JOIN handles h ON h.id = sf.player_id
        ORDER BY sf.games_window DESC
        LIMIT 15
      )
      SELECT
        handle, games_window, games_total, avg_ply, avg_opp,
        (SELECT key FROM jsonb_each_text(features->'eco_white')
          ORDER BY value::int DESC LIMIT 1) AS top_eco_white,
        (SELECT key FROM jsonb_each_text(features->'eco_black')
          ORDER BY value::int DESC LIMIT 1) AS top_eco_black,
        (SELECT key FROM jsonb_each_text(features->'time_class')
          ORDER BY value::int DESC LIMIT 1) AS top_time_class
      FROM ranked
    `;
    console.log('Top 15 handles by games_window:');
    for (const r of rows) {
      console.log(
        `  ${r.handle.padEnd(22)} games=${String(r.games_window).padStart(4)} ` +
          `avg_ply=${Number(r.avg_ply).toFixed(0).padStart(3)} ` +
          `opp_rating=${r.avg_opp ? Number(r.avg_opp).toFixed(0) : '   -'} ` +
          `top_eco_W=${r.top_eco_white ?? '   '} top_eco_B=${r.top_eco_black ?? '   '} ` +
          `pace=${r.top_time_class ?? '?'}`,
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
