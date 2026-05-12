/**
 * One-shot backfill: re-stream a previously-ingested Lichess dump, rebuild
 * the full PGN per game (headers + moveText incl. %eval/%clk comments),
 * and UPDATE existing `games` rows where pgn = ''. Idempotent — re-running
 * is a no-op on already-backfilled rows because of the `WHERE pgn = ''`
 * guard.
 *
 *   pnpm --filter @chessco/workers exec tsx \
 *     src/lichess-dumps/backfill-pgn.ts 2013-01
 *
 * The dump worker historically stored pgn = '' to save space (parse-game.ts
 * pre-patch). With Stockfish features in Phase 1 W5 we need the raw PGN
 * back — both to read embedded %eval comments and to feed Stockfish for
 * games without them.
 */
import 'dotenv/config';
import type postgres from 'postgres';
import { getGamesDb } from '../db';
import { dumpUrl } from './config';
import { downloadAndOpenDumpStream } from './download';
import { emptyFilterStats, shouldIngest } from './filter';
import { processGame } from './parse-game';
import { streamGames } from './pgn-stream';

interface CliArgs {
  dumpId: string;
  maxGames: number | null;
  dryRun: boolean;
}

const FLUSH_EVERY = 1000;

function parseArgs(argv: string[]): CliArgs {
  if (argv.length < 1 || !/^\d{4}-\d{2}$/.test(argv[0]!)) {
    throw new Error('Usage: backfill-pgn <YYYY-MM> [--max-games N] [--dry-run]');
  }
  const dumpId = argv[0]!;
  let maxGames: number | null = null;
  let dryRun = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max-games' && argv[i + 1]) maxGames = parseInt(argv[++i]!, 10);
    else if (a === '--dry-run') dryRun = true;
    else throw new Error(`Unrecognized arg: ${a}`);
  }
  return { dumpId, maxGames, dryRun };
}

interface PendingUpdate {
  source_game_id: string;
  played_at: string;
  pgn: string;
}

async function flush(sql: postgres.Sql, batch: PendingUpdate[]): Promise<number> {
  if (batch.length === 0) return 0;
  // One round-trip via jsonb_array_elements. We serialize to a JSON string
  // and cast inside the query — postgres-js v3 doesn't bind a JS Array to
  // a jsonb parameter directly.
  const json = JSON.stringify(batch);
  const updated = await sql<{ id: string }[]>`
    UPDATE games AS g
    SET pgn = v.pgn
    FROM (
      SELECT
        (val->>'source_game_id')::text AS source_game_id,
        (val->>'played_at')::timestamptz AS played_at,
        (val->>'pgn')::text AS pgn
      FROM jsonb_array_elements(${json}::jsonb) val
    ) v
    WHERE g.source = 'lichess'
      AND g.source_game_id = v.source_game_id
      AND g.played_at = v.played_at
      AND g.pgn = ''
    RETURNING g.id
  `;
  return updated.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = dumpUrl(args.dumpId);
  console.log(`[backfill-pgn] dump=${args.dumpId} dry-run=${args.dryRun}`);

  const dump = await downloadAndOpenDumpStream(url, args.dumpId);
  console.log(`[backfill-pgn] connected.`);

  const { client } = args.dryRun ? { client: null as postgres.Sql | null } : getGamesDb();

  const stats = emptyFilterStats();
  let seen = 0;
  let filteredIn = 0;
  let parseFailed = 0;
  let updatedRows = 0;
  const buffer: PendingUpdate[] = [];
  const startedAt = Date.now();

  for await (const game of streamGames(dump.text)) {
    seen++;
    if (args.maxGames && seen > args.maxGames) break;
    if (!shouldIngest(game.headers, stats)) continue;
    const out = processGame(game);
    if (!out) {
      parseFailed++;
      continue;
    }
    filteredIn++;
    if (!args.dryRun && client) {
      buffer.push({
        source_game_id: out.game.source_game_id,
        played_at: out.game.played_at.toISOString(),
        pgn: out.game.pgn,
      });
      if (buffer.length >= FLUSH_EVERY) {
        updatedRows += await flush(client, buffer);
        buffer.length = 0;
        if (filteredIn % 10_000 === 0) {
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
          console.log(
            `[backfill-pgn] filtered_in=${filteredIn.toLocaleString()} updated=${updatedRows.toLocaleString()} elapsed=${elapsed}s`,
          );
        }
      }
    }
  }
  if (!args.dryRun && client) {
    updatedRows += await flush(client, buffer);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[backfill-pgn] DONE`);
  console.log(`  seen          = ${seen.toLocaleString()}`);
  console.log(`  filtered_in   = ${filteredIn.toLocaleString()}`);
  console.log(`  parse_failed  = ${parseFailed.toLocaleString()}`);
  console.log(
    `  updated rows  = ${updatedRows.toLocaleString()}  (already-filled rows are skipped)`,
  );
  console.log(`  elapsed       = ${elapsed}s`);

  if (client) await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('[backfill-pgn] failed:', err);
  process.exit(1);
});
