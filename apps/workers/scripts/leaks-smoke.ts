/**
 * One-shot smoke check for Personalized Leaks data readiness.
 * Reports for the user's linked accounts and a candidate opponent:
 *   - is the handle in the corpus?
 *   - is it scout-ready?
 *   - does player_repertoires have rows? (white/black at depth 12+)
 *   - move eval coverage on the most recent ~100 games
 *
 *   tsx scripts/leaks-smoke.ts <opponent_handle>
 */
import 'dotenv/config';
import { getGamesDb } from '../src/db.js';

const TARGETS = [
  { platform: 'lichess', handle: 'noshit' },
  { platform: 'chess.com', handle: 'drbozi' },
];

async function check(
  client: ReturnType<typeof getGamesDb>['client'],
  platform: string,
  handle: string,
): Promise<void> {
  const norm = handle.toLowerCase();
  console.log(`\n── ${platform} / ${handle} ──`);
  const h = (await client`
    SELECT id::text, handle, platform, scout_ready_at, games_seen
    FROM handles WHERE platform = ${platform} AND LOWER(handle) = ${norm}
    LIMIT 1
  `) as Array<{
    id: string;
    handle: string;
    platform: string;
    scout_ready_at: string | null;
    games_seen: number;
  }>;
  if (h.length === 0) {
    console.log(`  ✗ not in corpus`);
    return;
  }
  const row = h[0]!;
  console.log(
    `  ✓ in corpus  id=${row.id}  games_seen=${row.games_seen}  scout_ready=${row.scout_ready_at ?? 'NO'}`,
  );

  const reps = (await client`
    SELECT color, depth, time_bucket, games_window
    FROM player_repertoires WHERE player_id = ${row.id}::uuid
    ORDER BY color, depth, time_bucket
  `) as Array<{ color: string; depth: number; time_bucket: string; games_window: number }>;
  console.log(`  repertoires: ${reps.length === 0 ? 'NONE' : reps.length + ' rows'}`);
  for (const r of reps.slice(0, 6)) {
    console.log(`    ${r.color} d=${r.depth} bucket=${r.time_bucket} games=${r.games_window}`);
  }

  const cov = (await client`
    WITH target_games AS (
      SELECT g.id FROM games g
      WHERE g.source = ${platform}
        AND (g.white_player_id = ${row.id}::uuid OR g.black_player_id = ${row.id}::uuid)
      ORDER BY g.played_at DESC LIMIT 100
    )
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE m.cp_loss IS NOT NULL)::int AS with_loss
    FROM moves m WHERE m.game_id IN (SELECT id FROM target_games)
  `) as Array<{ total: number; with_loss: number }>;
  const c = cov[0] ?? { total: 0, with_loss: 0 };
  const pct = c.total > 0 ? ((c.with_loss / c.total) * 100).toFixed(1) : '0.0';
  console.log(`  per-move eval coverage (last 100 games): ${c.with_loss}/${c.total} = ${pct}%`);
}

async function suggestOpponent(client: ReturnType<typeof getGamesDb>['client']): Promise<void> {
  console.log(`\n── opponent suggestions (scout-ready, top by games_seen) ──`);
  const rows = (await client`
    SELECT h.platform, h.handle, h.games_seen,
      EXISTS (SELECT 1 FROM player_repertoires pr WHERE pr.player_id = h.id) AS has_rep
    FROM handles h
    WHERE h.scout_ready_at IS NOT NULL
    ORDER BY h.games_seen DESC LIMIT 10
  `) as Array<{ platform: string; handle: string; games_seen: number; has_rep: boolean }>;
  for (const r of rows) {
    console.log(
      `  ${r.platform.padEnd(10)} ${r.handle.padEnd(28)} games=${r.games_seen.toString().padStart(7)}  rep=${r.has_rep ? 'yes' : 'NO'}`,
    );
  }
}

async function main(): Promise<void> {
  const { client } = getGamesDb();
  try {
    for (const t of TARGETS) await check(client, t.platform, t.handle);
    await suggestOpponent(client);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
