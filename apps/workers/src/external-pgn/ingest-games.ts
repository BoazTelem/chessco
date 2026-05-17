/**
 * external_pgn_sources → games/moves/positions ingester (Phase 1 step 4).
 *
 * Walks staged rows where at least one side has a resolved FIDE link and
 * no game_id yet. Parses each row's raw_pgn into a ProcessedGame, batches
 * the buffer, calls the canonical ingestBatch helper (lichess-dumps/
 * ingest.ts) inside one transaction, then back-links game_id +
 * game_ingested_at onto the staging row.
 *
 * Why we gate on FIDE resolution: TWIC issues are ~10k games each but
 * fewer than half feature a player we're tracking. Skipping the unresolved
 * majority saves the chess.js replay cost (the expensive step).
 *
 * Usage:
 *   pnpm --filter @chessco/workers external:ingest-games
 *   pnpm --filter @chessco/workers external:ingest-games -- --source twic
 *   pnpm --filter @chessco/workers external:ingest-games -- --issue twic1521
 *   pnpm --filter @chessco/workers external:ingest-games -- --max-rows 1000 --dry-run
 *
 * Idempotent: each row's game_id back-link is only set if currently NULL.
 * Re-running picks up new arrivals (resolved since last run) without
 * touching the already-ingested ones.
 */
import 'dotenv/config';
import type postgres from 'postgres';
import { getGamesDb } from '../db';
import { ingestBatch } from '../lichess-dumps/ingest';
import { processExternalGame } from './lib/process-game';
import { streamGames } from '../lichess-dumps/pgn-stream';
import { Readable } from 'node:stream';
import type { ProcessedGame } from '../lichess-dumps/parse-game';
import type { ParsedGame } from '../lichess-dumps/types';

const BATCH_SIZE = 500;

interface CliArgs {
  source: string | null;
  issue: string | null;
  maxRows: number | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { source: null, issue: null, maxRows: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source' && argv[i + 1]) out.source = argv[++i]!;
    else if (a === '--issue' && argv[i + 1]) out.issue = argv[++i]!;
    else if (a === '--max-rows' && argv[i + 1]) out.maxRows = Number.parseInt(argv[++i]!, 10);
    else if (a === '--dry-run') out.dryRun = true;
    else throw new Error(`Unrecognized arg: ${a}`);
  }
  return out;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

interface PendingRow {
  id: string;
  source: 'twic'; // tighten as new sources land
  source_url: string;
  raw_pgn: string;
}

async function readPending(sql: postgres.Sql, args: CliArgs): Promise<PendingRow[]> {
  // Only ingest rows with a resolved FIDE link — that's the audience we
  // care about. Saves chess.js work on the long tail of unmatched games.
  const sourceFilter = args.source;
  const issueFilter = args.issue;
  const limit = args.maxRows;
  return sql<PendingRow[]>`
    SELECT id::text, source, source_url, raw_pgn
    FROM external_pgn_sources
    WHERE game_id IS NULL
      AND (white_fide_id IS NOT NULL OR black_fide_id IS NOT NULL)
      ${sourceFilter ? sql`AND source = ${sourceFilter}` : sql``}
      ${issueFilter ? sql`AND source_issue = ${issueFilter}` : sql``}
    ORDER BY fetched_at ASC
    ${limit ? sql`LIMIT ${limit}` : sql``}
  `;
}

/** Parse a single-game PGN string back into a ParsedGame via the streaming
 *  parser. We push one ParsedGame in, get one out. streamGames is line-
 *  driven and only flushes on newlines, so we ensure the move-text line
 *  has a trailing terminator before handing it off. */
async function parseSinglePgn(raw: string): Promise<ParsedGame | null> {
  const normalised = raw.endsWith('\n') ? raw : raw + '\n\n';
  const stream = Readable.from([normalised]);
  for await (const g of streamGames(stream)) return g;
  return null;
}

interface ProcessResult {
  row: PendingRow;
  processed: ProcessedGame | null;
}

async function processRows(rows: PendingRow[]): Promise<ProcessResult[]> {
  const out: ProcessResult[] = [];
  for (const row of rows) {
    try {
      const parsed = await parseSinglePgn(row.raw_pgn);
      if (!parsed) {
        out.push({ row, processed: null });
        continue;
      }
      const processed = processExternalGame({
        game: parsed,
        source: row.source,
        sourceGameId: row.source_url,
      });
      out.push({ row, processed });
    } catch {
      out.push({ row, processed: null });
    }
  }
  return out;
}

async function backLinkGameIds(
  sql: postgres.Sql,
  inserted: Array<{ external_id: string; game_id: string }>,
): Promise<number> {
  if (inserted.length === 0) return 0;
  const CHUNK = 500;
  let touched = 0;
  for (let i = 0; i < inserted.length; i += CHUNK) {
    const slice = inserted.slice(i, i + CHUNK);
    const result = await sql<{ id: string }[]>`
      UPDATE external_pgn_sources
      SET game_id = r.game_id::uuid,
          game_ingested_at = NOW()
      FROM jsonb_to_recordset(${JSON.stringify(slice)}::jsonb)
        AS r(external_id text, game_id text)
      WHERE external_pgn_sources.id = r.external_id::uuid
        AND external_pgn_sources.game_id IS NULL
      RETURNING external_pgn_sources.id::text
    `;
    touched += result.length;
  }
  return touched;
}

/** Look up game_id for a list of (source, source_game_id) pairs.
 *  Used to back-link after ingestBatch (which doesn't expose the
 *  source_game_id → game_id map in its return value). */
async function lookupGameIds(
  sql: postgres.Sql,
  source: string,
  sourceGameIds: string[],
): Promise<Map<string, string>> {
  if (sourceGameIds.length === 0) return new Map();
  const rows = await sql<{ id: string; source_game_id: string }[]>`
    SELECT id::text, source_game_id
    FROM games
    WHERE source = ${source}
      AND source_game_id = ANY(${sourceGameIds}::text[])
  `;
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.source_game_id, r.id);
  return map;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const games = getGamesDb();

  console.log(
    `[ingest-games] ${args.source ? `source=${args.source}` : ''}` +
      `${args.issue ? ` issue=${args.issue}` : ''}` +
      `${args.maxRows ? ` max-rows=${args.maxRows}` : ''}` +
      `${args.dryRun ? ' DRY-RUN' : ''}`,
  );

  try {
    const t0 = Date.now();
    const pending = await readPending(games.client, args);
    console.log(`[ingest-games] ${fmt(pending.length)} pending rows`);

    if (pending.length === 0) {
      console.log('[ingest-games] nothing to do.');
      return;
    }

    let totalIngested = 0;
    let totalSkipped = 0;
    let totalBacklinked = 0;

    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const slice = pending.slice(i, i + BATCH_SIZE);
      const processed = await processRows(slice);

      const valid = processed.filter(
        (p): p is ProcessResult & { processed: ProcessedGame } => p.processed !== null,
      );
      const skipped = processed.length - valid.length;
      totalSkipped += skipped;

      if (args.dryRun) {
        totalIngested += valid.length;
        console.log(
          `  · [${fmt(i + slice.length)}/${fmt(pending.length)}] would ingest ${fmt(valid.length)}, skip ${fmt(skipped)}`,
        );
        continue;
      }

      const batch = valid.map((v) => v.processed);
      const stats = await ingestBatch(games.client, batch);

      const sourceGameIds = valid.map((v) => v.row.source_url);
      const gameIdMap = await lookupGameIds(
        games.client,
        valid[0]?.row.source ?? 'twic',
        sourceGameIds,
      );

      const backLinks = valid
        .map((v) => {
          const gameId = gameIdMap.get(v.row.source_url);
          if (!gameId) return null;
          return { external_id: v.row.id, game_id: gameId };
        })
        .filter((x): x is { external_id: string; game_id: string } => x !== null);

      const backLinked = await backLinkGameIds(games.client, backLinks);
      totalIngested += stats.games;
      totalBacklinked += backLinked;

      console.log(
        `  · [${fmt(i + slice.length)}/${fmt(pending.length)}] ingested ${fmt(stats.games)} games, ` +
          `${fmt(stats.positions_inserted)} new positions, ${fmt(stats.moves)} moves; ` +
          `back-linked ${fmt(backLinked)}; skipped ${fmt(skipped)}`,
      );
    }

    const totalDt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n[ingest-games] DONE in ${totalDt}s`);
    console.log(`  pending rows seen: ${fmt(pending.length)}`);
    console.log(`  ingested to games: ${fmt(totalIngested)}`);
    console.log(`  back-linked to external_pgn_sources: ${fmt(totalBacklinked)}`);
    console.log(`  skipped (parse/replay failed): ${fmt(totalSkipped)}`);
  } finally {
    await games.client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('ingest-games failed:', err);
  process.exit(1);
});
