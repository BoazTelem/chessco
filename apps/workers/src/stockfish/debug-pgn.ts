/** Debug: fetch one PGN, print first 500 chars, try loading it in chess.js. */
import 'dotenv/config';
import { Chess } from 'chess.js';
import { getGamesDb } from '../db';

async function main() {
  const { client } = getGamesDb();
  const rows = await client<{ id: string; pgn: string; ply_count: number }[]>`
    SELECT id, pgn, ply_count FROM games WHERE source = 'lichess' AND ply_count BETWEEN 25 AND 120 LIMIT 1
  `;
  const row = rows[0]!;
  console.log('--- raw PGN (first 600 chars) ---');
  console.log(row.pgn.slice(0, 600));
  console.log('--- raw PGN (end) ---');
  console.log(row.pgn.slice(-300));
  console.log('--- raw PGN length:', row.pgn.length, 'ply_count claimed:', row.ply_count);

  const chess = new Chess();
  try {
    chess.loadPgn(row.pgn, { strict: false });
    const h = chess.history({ verbose: true });
    console.log(`--- loadPgn succeeded. history.length = ${h.length}`);
    if (h.length > 0)
      console.log(
        'first 5:',
        h
          .slice(0, 5)
          .map((m) => m.san)
          .join(' '),
      );
  } catch (e) {
    console.error('loadPgn threw:', e);
  }

  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
