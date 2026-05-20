/**
 * One-off: count fingerprinted FIDE players by tier vs the FIDE pool.
 *
 * Joins:
 *   - games DB account_fingerprints WHERE platform='fide' (handle = federation_player_id)
 *   - Supabase federation_players (rating_standard, title)
 *
 * Output: text summary to stdout. Not published anywhere.
 */
import 'dotenv/config';
import { getDb, getGamesDb } from '../db';

const TITLED = ['GM', 'IM', 'FM', 'CM', 'WGM', 'WIM', 'WFM', 'WCM'];

async function main() {
  const games = getGamesDb();
  const fed = getDb();
  try {
    const fpRows = await games.client<{ handle: string; games_window: number }[]>`
      SELECT handle, games_window FROM account_fingerprints WHERE platform = 'fide'
    `;
    const fingerprintedIds = fpRows.map((r) => r.handle);
    console.log(`fingerprinted FIDE handles: ${fingerprintedIds.length}`);
    if (fingerprintedIds.length === 0) return;

    const window10 = fpRows.filter((r) => r.games_window >= 10).length;
    console.log(`  ≥10 games: ${window10}`);

    // Tier breakdown
    const tiered = await fed.client<{ tier: string; n: string }[]>`
      WITH fp(id) AS (
        SELECT id::uuid FROM unnest(${fingerprintedIds}::text[]) AS t(id)
      )
      SELECT
        CASE
          WHEN fp_titled.titled IS TRUE THEN 'titled'
          WHEN p.rating_standard >= 2200 THEN '2200+'
          WHEN p.rating_standard BETWEEN 2000 AND 2199 THEN '2000-2199'
          WHEN p.rating_standard BETWEEN 1800 AND 1999 THEN '1800-1999'
          WHEN p.rating_standard BETWEEN 1400 AND 1799 THEN '1400-1799'
          ELSE 'sub1400_or_unrated'
        END AS tier,
        COUNT(*)::text AS n
      FROM fp
      JOIN federation_players p ON p.id = fp.id
      LEFT JOIN LATERAL (
        SELECT p.title = ANY(${TITLED}::text[]) AS titled
      ) fp_titled ON true
      GROUP BY 1
      ORDER BY 1
    `;
    console.log('\nFingerprinted by tier:');
    for (const r of tiered) console.log(`  ${r.tier.padEnd(22)} ${r.n}`);

    const pool = await fed.client<{ tier: string; n: string }[]>`
      SELECT
        CASE
          WHEN title = ANY(${TITLED}::text[]) THEN 'titled'
          WHEN rating_standard >= 2200 THEN '2200+'
          WHEN rating_standard BETWEEN 2000 AND 2199 THEN '2000-2199'
          WHEN rating_standard BETWEEN 1800 AND 1999 THEN '1800-1999'
          WHEN rating_standard BETWEEN 1400 AND 1799 THEN '1400-1799'
          ELSE 'sub1400_or_unrated'
        END AS tier,
        COUNT(*)::text AS n
      FROM federation_players
      WHERE rating_standard >= 1400 OR title = ANY(${TITLED}::text[])
      GROUP BY 1
      ORDER BY 1
    `;
    console.log('\nPrep pool by tier (FIDE 1400+ or titled):');
    for (const r of pool) console.log(`  ${r.tier.padEnd(22)} ${r.n}`);

    // Check external_pgn_sources funnel: how many distinct FIDE players have any games at all
    const seenAny = await games.client<{ n: string }[]>`
      SELECT COUNT(DISTINCT fed_id)::text AS n FROM (
        SELECT white_fide_id AS fed_id FROM external_pgn_sources WHERE white_fide_id IS NOT NULL
        UNION
        SELECT black_fide_id FROM external_pgn_sources WHERE black_fide_id IS NOT NULL
      ) s
    `;
    console.log(`\nDistinct FIDE players with ≥1 ingested game: ${seenAny[0]?.n}`);

    const below10 = await games.client<{ buckets: string }[]>`
      WITH per_player AS (
        SELECT fed_id, COUNT(*) AS g FROM (
          SELECT white_fide_id AS fed_id FROM external_pgn_sources WHERE white_fide_id IS NOT NULL
          UNION ALL
          SELECT black_fide_id FROM external_pgn_sources WHERE black_fide_id IS NOT NULL
        ) s GROUP BY 1
      )
      SELECT
        json_build_object(
          '1-2_games',   COUNT(*) FILTER (WHERE g BETWEEN 1 AND 2),
          '3-4_games',   COUNT(*) FILTER (WHERE g BETWEEN 3 AND 4),
          '5-9_games',   COUNT(*) FILTER (WHERE g BETWEEN 5 AND 9),
          '10-19_games', COUNT(*) FILTER (WHERE g BETWEEN 10 AND 19),
          '20-49_games', COUNT(*) FILTER (WHERE g BETWEEN 20 AND 49),
          '50plus',      COUNT(*) FILTER (WHERE g >= 50)
        )::text AS buckets
      FROM per_player
    `;
    console.log('\nIngested-games histogram (per FIDE player):');
    console.log(`  ${below10[0]?.buckets}`);
  } finally {
    await games.client.end({ timeout: 5 });
    await fed.client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
