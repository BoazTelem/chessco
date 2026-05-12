/**
 * End-to-end proof: pull one real PGN from the games corpus, run
 * analyzeGame() on it, print the cp-loss aggregates. Validates the full
 * pipeline before we commit to a backfill.
 *
 *   pnpm --filter @chessco/workers exec tsx src/stockfish/proof.ts
 *   pnpm --filter @chessco/workers exec tsx src/stockfish/proof.ts --handle karen_armenia
 */
import 'dotenv/config';
import { getGamesDb } from '../db';
import { analyzeGame } from '../lib/analyze-game';
import { StockfishEngine } from '../lib/stockfish';

interface CliArgs {
  filterHandle: string | null;
  depth: number;
  limit: number;
}

function parseArgs(argv: string[]): CliArgs {
  let filterHandle: string | null = null;
  let depth = 10;
  let limit = 1;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--handle' && argv[i + 1]) filterHandle = argv[++i]!.toLowerCase();
    else if (a === '--depth' && argv[i + 1]) depth = parseInt(argv[++i]!, 10);
    else if (a === '--limit' && argv[i + 1]) limit = parseInt(argv[++i]!, 10);
    else throw new Error(`unknown arg: ${a}`);
  }
  return { filterHandle, depth, limit };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[proof] handle=${args.filterHandle ?? '(any)'} depth=${args.depth} limit=${args.limit}`,
  );

  const { client } = getGamesDb();

  interface Row {
    id: string;
    pgn: string;
    white_handle_snapshot: string | null;
    black_handle_snapshot: string | null;
    ply_count: number;
    result: string;
  }

  const rows = await client<Row[]>`
    SELECT id, pgn, white_handle_snapshot, black_handle_snapshot, ply_count, result
    FROM games
    WHERE length(pgn) > 0
      AND ply_count BETWEEN 25 AND 120
      ${
        args.filterHandle
          ? client`AND (LOWER(white_handle_snapshot) = ${args.filterHandle} OR LOWER(black_handle_snapshot) = ${args.filterHandle})`
          : client``
      }
    ORDER BY played_at DESC
    LIMIT ${args.limit}
  `;

  if (rows.length === 0) {
    console.log('[proof] no games matched the filter.');
    await client.end();
    return;
  }

  console.log(`[proof] starting Stockfish engine...`);
  const sf = await StockfishEngine.start('lite-single');

  for (const row of rows) {
    console.log(
      `\n[proof] game ${row.id.slice(0, 8)}…  ${row.white_handle_snapshot}/${row.black_handle_snapshot}  result=${row.result}  plies=${row.ply_count}`,
    );
    const t0 = Date.now();
    const a = await analyzeGame(sf, row.pgn, { depth: args.depth });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[proof]   analyzed in ${dt}s`);
    console.log(`[proof]   plies_analyzed = ${a.plies_analyzed}`);
    console.log(`[proof]   mean_cp_loss   = ${a.mean_cp_loss?.toFixed(1) ?? 'null'}`);
    console.log(
      `[proof]     white = ${a.mean_cp_loss_white?.toFixed(1) ?? 'null'}, black = ${a.mean_cp_loss_black?.toFixed(1) ?? 'null'}`,
    );
    console.log(`[proof]   blunder_count  = ${a.blunder_count}`);
  }

  await sf.quit();
  await client.end({ timeout: 5 });
  console.log('\n[proof] DONE.');
}

main().catch((err) => {
  console.error('[proof] failed:', err);
  process.exit(1);
});
