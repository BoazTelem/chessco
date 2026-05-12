/**
 * Stage 2 CLI — given a federation_player UUID OR a federation+id pair,
 * load the player and run handle candidate generation.
 *
 * Usage:
 *   pnpm --filter @chessco/workers stage2 FIDE 2805677    # Boris Gelfand
 *   pnpm --filter @chessco/workers stage2 FIDE 1503014    # Magnus Carlsen
 *   pnpm --filter @chessco/workers stage2 <uuid>
 */
import 'dotenv/config';
import { getDb } from '../db';
import { runStage2 } from './stage2';

interface FederationPlayer {
  id: string;
  federation_id: string;
  federation_player_id: string;
  name: string;
  country: string | null;
  birth_year: number | null;
  title: string | null;
  rating_standard: number | null;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    throw new Error('Usage: stage2 <FEDERATION_ID> <PLAYER_ID> | <UUID>');
  }

  const { client } = getDb();
  try {
    let player: FederationPlayer | undefined;
    if (argv.length === 1) {
      const rows = await client<FederationPlayer[]>`
        SELECT id, federation_id, federation_player_id, name, country, birth_year, title, rating_standard
        FROM federation_players WHERE id = ${argv[0]!}
      `;
      player = rows[0];
    } else {
      const rows = await client<FederationPlayer[]>`
        SELECT id, federation_id, federation_player_id, name, country, birth_year, title, rating_standard
        FROM federation_players
        WHERE federation_id = ${argv[0]!} AND federation_player_id = ${argv[1]!}
      `;
      player = rows[0];
    }
    if (!player) throw new Error('Player not found.');

    console.log(
      `Stage 2 for ${player.name} (${player.federation_id} ${player.federation_player_id})`,
    );
    console.log(
      `  country=${player.country} birth_year=${player.birth_year} title=${player.title} ` +
        `fide=${player.rating_standard}`,
    );

    const t0 = Date.now();
    const candidates = await runStage2(client, {
      name: player.name,
      country: player.country,
      birth_year: player.birth_year,
      fide_rating: player.rating_standard,
      title: player.title,
    });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);

    console.log(`\nTop ${Math.min(15, candidates.length)} candidates (${dt}s):`);
    for (const [i, c] of candidates.slice(0, 15).entries()) {
      const conf = (c.confidence * 100).toFixed(0);
      const ratings = c.ratings
        ? `bu=${c.ratings.bullet ?? '-'} bl=${c.ratings.blitz ?? '-'} ra=${c.ratings.rapid ?? '-'} cl=${c.ratings.classical ?? '-'}`
        : '';
      console.log(
        `  ${String(i + 1).padStart(2)}. [${c.platform.padEnd(9)}] ${c.handle.padEnd(20)} ` +
          `${conf}%  ${c.source}  ${c.title ?? '   '}  ${c.country ?? '   '}  ${ratings}`,
      );
      console.log(`        reasons: ${c.reasons.join(' · ')}`);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('Stage 2 run failed:', err);
  process.exit(1);
});
