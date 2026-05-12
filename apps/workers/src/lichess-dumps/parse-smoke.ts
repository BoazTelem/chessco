/**
 * Offline parser smoke test — no network, no DB.
 * Streams the sample fixture through pgn-stream → filter → parse-game
 * and prints summary so we know the pipeline is sane.
 */
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyFilterStats, shouldIngest } from './filter';
import { processGame } from './parse-game';
import { streamGames } from './pgn-stream';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const input = createReadStream(path.join(here, 'fixtures', 'sample.pgn'), {
    encoding: 'utf8',
  });
  const stats = emptyFilterStats();
  let processed = 0;
  let totalMoves = 0;
  let totalPositions = 0;

  for await (const game of streamGames(input)) {
    if (!shouldIngest(game.headers, stats)) {
      console.log(
        `  ✗ filtered: ${game.headers.Site} (event=${game.headers.Event} ` +
          `Elo=${game.headers.WhiteElo}/${game.headers.BlackElo})`,
      );
      continue;
    }
    const out = processGame(game);
    if (!out) {
      console.log(`  ⚠ parse failed: ${game.headers.Site}`);
      continue;
    }
    processed++;
    totalMoves += out.moves.length;
    totalPositions += out.positions.length;
    console.log(
      `  ✓ ${out.game.source_game_id}  ` +
        `${out.game.white_handle_snapshot}(${out.game.white_rating}) vs ` +
        `${out.game.black_handle_snapshot}(${out.game.black_rating})  ` +
        `${out.game.result}  ${out.moves.length} moves  ` +
        `${out.game.time_class}  played_at=${out.game.played_at.toISOString()}`,
    );
    // Spot-check: print first move + its annotations.
    const m0 = out.moves[0];
    if (m0) {
      console.log(
        `      ply 1: ${m0.san} (uci=${m0.uci}) clk_w=${m0.clock_white_ms}ms ` +
          `eval_cp=${m0.eval_cp}`,
      );
    }
  }

  console.log('\n--- Summary ---');
  console.log('  filter stats   :', stats);
  console.log('  games processed:', processed);
  console.log('  total moves    :', totalMoves);
  console.log('  total positions:', totalPositions);
}

main().catch((err) => {
  console.error('parse smoke failed:', err);
  process.exit(1);
});
