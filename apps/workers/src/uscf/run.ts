/**
 * CLI entry point for the USCF ingestion worker.
 *
 *   pnpm --filter @chessco/workers uscf:ingest                       # full run
 *   pnpm --filter @chessco/workers uscf:ingest:test                  # first category only
 *   pnpm --filter @chessco/workers uscf:ingest -- --nationwide-only  # skip per-state lists
 *
 * Reads DATABASE_URL from apps/workers/.env (gitignored) or the env.
 *
 * Local note: Playwright's bundled Chromium is not part of `playwright-core`.
 * Either point `PLAYWRIGHT_EXECUTABLE_PATH` at a local Chrome install, or run
 * via the Cloud Run image (see apps/workers/Dockerfile.uscf) which bundles
 * Chromium.
 */
import 'dotenv/config';
import { getDb } from '../db.js';
import { runUscfIngest } from './ingest.js';

async function main() {
  const args = process.argv.slice(2);
  const maxCategoriesArg = args.indexOf('--max-categories');
  const maxCategories =
    maxCategoriesArg >= 0 ? parseInt(args[maxCategoriesArg + 1] ?? '', 10) || undefined : undefined;
  const delayArg = args.indexOf('--delay');
  const delayMs = delayArg >= 0 ? parseInt(args[delayArg + 1] ?? '', 10) || undefined : undefined;
  const nationwideOnly = args.includes('--nationwide-only');

  if (maxCategories) {
    console.log(`[uscf] TEST MODE — limiting to ${maxCategories} categories`);
  }
  if (nationwideOnly) {
    console.log(`[uscf] NATIONWIDE-ONLY — skipping per-state top-100 lists`);
  }

  const { client } = getDb();
  try {
    const result = await runUscfIngest(client, {
      maxCategories,
      delayMs,
      nationwideOnly,
      triggeredBy: process.env.TRIGGERED_BY ?? 'cli',
    });
    console.log('\n=== Run summary ===');
    console.log(`Run ID:           ${result.runId}`);
    console.log(`Categories:       ${result.metrics.categories_scraped}`);
    console.log(`Rows scraped:     ${result.metrics.rows_scraped}`);
    console.log(`Unique players:   ${result.metrics.unique_players}`);
    console.log(`Inserted:         ${result.metrics.inserted}`);
    console.log(`Updated:          ${result.metrics.updated}`);
    console.log(`Unchanged:        ${result.metrics.skipped}`);
    console.log(`Snapshots:        ${result.metrics.snapshots}`);
    console.log(`Duration:         ${result.metrics.duration_seconds}s`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('USCF ingest failed:', err);
  process.exit(1);
});
