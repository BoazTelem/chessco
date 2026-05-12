/**
 * CLI entry point for the ICF ingestion worker.
 *
 *   pnpm --filter @chessco/workers icf:ingest          # full run
 *   pnpm --filter @chessco/workers icf:ingest:test     # first 2 pages only
 */
import 'dotenv/config';
import { getDb } from '../db.js';
import { runIcfIngest } from './ingest.js';

async function main() {
  const args = process.argv.slice(2);
  const maxPagesArg = args.indexOf('--max-pages');
  const maxPages =
    maxPagesArg >= 0 ? parseInt(args[maxPagesArg + 1] ?? '', 10) || undefined : undefined;
  const delayArg = args.indexOf('--delay');
  const delayMs = delayArg >= 0 ? parseInt(args[delayArg + 1] ?? '', 10) || undefined : undefined;

  if (maxPages) {
    console.log(`[icf] TEST MODE — limiting to ${maxPages} pages`);
  }

  const { client } = getDb();
  try {
    const result = await runIcfIngest(client, {
      maxPages,
      delayMs,
      triggeredBy: 'cli',
    });
    console.log('\n=== Run summary ===');
    console.log(`Run ID:       ${result.runId}`);
    console.log(`Pages:        ${result.metrics.pages_fetched}+`);
    console.log(`Scraped:      ${result.metrics.rows_scraped}`);
    console.log(`Inserted:     ${result.metrics.inserted}`);
    console.log(`Updated:      ${result.metrics.updated}`);
    console.log(`Unchanged:    ${result.metrics.skipped}`);
    console.log(`Snapshots:    ${result.metrics.snapshots}`);
    console.log(`Duration:     ${result.metrics.duration_seconds}s`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('ICF ingest failed:', err);
  process.exit(1);
});
