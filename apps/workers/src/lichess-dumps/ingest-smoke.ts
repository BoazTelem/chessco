/**
 * End-to-end smoke against Cloud SQL using the fixture PGN.
 * Validates positions/games/moves writes (and dedup) before we
 * attach the network download layer.
 *
 * Run twice in a row to verify ON CONFLICT idempotency: the second
 * run should write 0 new games and 0 new positions.
 */
import 'dotenv/config';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGamesDb } from '../db';
import { emptyFilterStats, shouldIngest } from './filter';
import { ingestBatch } from './ingest';
import { processGame } from './parse-game';
import { streamGames } from './pgn-stream';
import type { ProcessedGame } from './parse-game';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const input = createReadStream(path.join(here, 'fixtures', 'sample.pgn'), {
    encoding: 'utf8',
  });
  const stats = emptyFilterStats();
  const buffer: ProcessedGame[] = [];

  for await (const game of streamGames(input)) {
    if (!shouldIngest(game.headers, stats)) continue;
    const out = processGame(game);
    if (out) buffer.push(out);
  }

  console.log('filter stats:', stats);
  console.log('processed   :', buffer.length, 'games');
  console.log(
    'moves total :',
    buffer.reduce((n, g) => n + g.moves.length, 0),
  );
  console.log(
    'positions   :',
    buffer.reduce((n, g) => n + g.positions.length, 0),
    '(pre-dedup)',
  );

  const { client } = getGamesDb();
  try {
    const t0 = Date.now();
    const r = await ingestBatch(client, buffer);
    const dt = Date.now() - t0;
    console.log('\n--- Ingest result ---');
    console.log('  games inserted    :', r.games);
    console.log('  positions inserted:', r.positions_inserted);
    console.log('  positions dedup hits (already existed):', r.positions_dedup_hits);
    console.log('  moves inserted    :', r.moves);
    console.log('  duration          :', dt, 'ms');

    // Re-query to make sure the rows are visible.
    const verify = await client<{ source_game_id: string; ply_count: number }[]>`
      SELECT source_game_id, ply_count FROM games
      WHERE source = 'lichess'
      ORDER BY played_at
    `;
    console.log('\n--- Verify games visible ---');
    for (const row of verify) {
      console.log(`  · ${row.source_game_id} (${row.ply_count} plies)`);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('ingest smoke failed:', err);
  process.exit(1);
});
