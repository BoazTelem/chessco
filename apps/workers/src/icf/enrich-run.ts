/**
 * CLI entry for ICF per-player enrichment.
 *
 *   pnpm --filter @chessco/workers icf:enrich                  # 1000 rows
 *   pnpm --filter @chessco/workers icf:enrich -- --max 100     # 100 rows
 *   pnpm --filter @chessco/workers icf:enrich -- --max 10 --delay 500
 *
 * Designed to be re-runnable. The orchestrator targets never-enriched
 * rows first (ordered by `raw.last_enriched_at NULLS FIRST`), so a
 * second run picks up where the first left off.
 */
import 'dotenv/config';
import { getDb } from '../db.js';
import { runIcfEnrichment } from './enrich.js';

async function main() {
  const args = process.argv.slice(2);
  const maxArg = args.indexOf('--max');
  const maxRows = maxArg >= 0 ? parseInt(args[maxArg + 1] ?? '', 10) || undefined : undefined;
  const delayArg = args.indexOf('--delay');
  const delayMs = delayArg >= 0 ? parseInt(args[delayArg + 1] ?? '', 10) || undefined : undefined;

  const { client } = getDb();
  try {
    const result = await runIcfEnrichment(client, {
      maxRows,
      delayMs,
      triggeredBy: 'cli',
    });
    console.log('\n=== Run summary ===');
    console.log(`Run ID:       ${result.runId}`);
    console.log(`Targeted:     ${result.metrics.rows_targeted}`);
    console.log(`Fetched:      ${result.metrics.rows_fetched}`);
    console.log(`Updated:      ${result.metrics.rows_updated}`);
    console.log(`Failed:       ${result.metrics.rows_failed}`);
    console.log(`Duration:     ${result.metrics.duration_seconds}s`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('ICF enrichment failed:', err);
  process.exit(1);
});
