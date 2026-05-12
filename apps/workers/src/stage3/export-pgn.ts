/**
 * Reconstruct a minimal PGN blob from games in the corpus for a single
 * handle. Used to feed the web's sample-game form for end-to-end testing.
 *
 *   pnpm --filter @chessco/workers stage3:export lichess karen_armenia 10 > /tmp/k.pgn
 */
import 'dotenv/config';
import { getGamesDb } from '../db';

async function main() {
  const [platform, handle, nStr] = process.argv.slice(2);
  if (!platform || !handle || !nStr) {
    throw new Error('Usage: stage3:export <platform> <handle> <N>');
  }
  const n = Number.parseInt(nStr, 10);
  const { client } = getGamesDb();
  try {
    const games = await client<
      {
        id: string;
        source_game_id: string;
        white: string | null;
        black: string | null;
        white_elo: number | null;
        black_elo: number | null;
        result: string;
        time_control: string | null;
        eco: string | null;
        opening_name: string | null;
        termination: string | null;
        played_at: string;
        ply_count: number;
      }[]
    >`
      SELECT id, source_game_id,
        white_handle_snapshot AS white, black_handle_snapshot AS black,
        white_rating AS white_elo, black_rating AS black_elo,
        result, time_control,
        opening_eco AS eco, opening_name, termination,
        played_at::text, ply_count
      FROM games
      WHERE source = ${platform}
        AND (LOWER(white_handle_snapshot) = ${handle.toLowerCase()}
          OR LOWER(black_handle_snapshot) = ${handle.toLowerCase()})
      ORDER BY random() LIMIT ${n}
    `;

    for (const g of games) {
      const moves = await client<{ san: string; ply: number }[]>`
        SELECT san, ply FROM moves WHERE game_id = ${g.id} ORDER BY ply
      `;
      const moveText = moves
        .map((m, i) => {
          if (i % 2 === 0) return `${Math.floor(i / 2) + 1}. ${m.san}`;
          return m.san;
        })
        .join(' ');

      const dateOnly = g.played_at.split(' ')[0]?.replace(/-/g, '.') ?? '????.??.??';
      const headers =
        `[Event "Rated Standard game"]\n` +
        `[Site "lichess.org/${g.source_game_id}"]\n` +
        `[Date "${dateOnly}"]\n` +
        `[White "${g.white ?? '?'}"]\n` +
        `[Black "${g.black ?? '?'}"]\n` +
        `[Result "${g.result}"]\n` +
        (g.white_elo ? `[WhiteElo "${g.white_elo}"]\n` : '') +
        (g.black_elo ? `[BlackElo "${g.black_elo}"]\n` : '') +
        (g.time_control ? `[TimeControl "${g.time_control}"]\n` : '') +
        (g.eco ? `[ECO "${g.eco}"]\n` : '') +
        (g.opening_name ? `[Opening "${g.opening_name}"]\n` : '') +
        (g.termination ? `[Termination "${g.termination}"]\n` : '');

      process.stdout.write(`${headers}\n${moveText} ${g.result}\n\n`);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
