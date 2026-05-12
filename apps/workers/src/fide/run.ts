/**
 * CLI entry point for the FIDE ingestion worker.
 *
 *   pnpm --filter @chessco/workers fide:ingest
 *   pnpm --filter @chessco/workers fide:ingest:test     # only 100 players per file
 *
 * Reads DATABASE_URL from apps/workers/.env (gitignored) or the env.
 */
import 'dotenv/config';
import { getDb } from '../db.js';
import { runFideIngest } from './ingest.js';

async function main() {
  const args = process.argv.slice(2);
  const maxPlayersArg = args.indexOf('--max-players');
  const maxPlayers =
    maxPlayersArg >= 0 ? parseInt(args[maxPlayersArg + 1] ?? '', 10) || undefined : undefined;

  if (maxPlayers) {
    console.log(`[fide] TEST MODE — limiting to ${maxPlayers} players per file`);
  }

  const { client } = getDb();
  try {
    const result = await runFideIngest(client, {
      maxPlayers,
      triggeredBy: 'cli',
    });
    console.log('\n=== Run summary ===');
    console.log(`Run ID:       ${result.runId}`);
    console.log(`Downloaded:   ${(result.metrics.downloaded_bytes / 1024 / 1024).toFixed(1)} MB`);
    console.log(
      `Parsed:       std=${result.metrics.parsed.standard}, rapid=${result.metrics.parsed.rapid}, blitz=${result.metrics.parsed.blitz}`,
    );
    console.log(`Unique:       ${result.metrics.unique_players}`);
    console.log(`Inserted:     ${result.metrics.inserted}`);
    console.log(`Updated:      ${result.metrics.updated}`);
    console.log(`Unchanged:    ${result.metrics.skipped}`);
    console.log(`Snapshots:    ${result.metrics.snapshots}`);
    console.log(`Parse errors: ${result.metrics.parse_errors}`);
    console.log(`Duration:     ${result.metrics.duration_seconds}s`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('FIDE ingest failed:', err);
  process.exit(1);
});
