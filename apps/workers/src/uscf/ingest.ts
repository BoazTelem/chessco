/**
 * USCF ingestion orchestrator. Same shape as the FIDE and ICF orchestrators
 * so the Inngest cron function in `apps/workers/src/inngest/federations.ts`
 * can swap them.
 */
import type postgres from 'postgres';
import { scrapeUscf, type UscfRow } from './scrape.js';
import { dedupeUscfRows, upsertUscfRows } from './upsert.js';

export type IngestOptions = {
  maxCategories?: number;
  delayMs?: number;
  nationwideOnly?: boolean;
  triggeredBy?: string;
  log?: (msg: string) => void;
};

export type IngestResult = {
  runId: string;
  metrics: {
    categories_scraped: number;
    rows_scraped: number;
    unique_players: number;
    inserted: number;
    updated: number;
    skipped: number;
    snapshots: number;
    duration_seconds: number;
  };
};

export async function runUscfIngest(
  sql: postgres.Sql,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const startedAt = Date.now();

  const runRows = await sql<{ id: string }[]>`
    INSERT INTO ingestion_runs (worker, status, triggered_by)
    VALUES ('uscf', 'running', ${opts.triggeredBy ?? 'cli'})
    RETURNING id
  `;
  const firstRow = runRows[0];
  if (!firstRow) throw new Error('Failed to insert ingestion_runs row');
  const runId = firstRow.id;
  log(`[uscf] run ${runId} started`);

  try {
    const allRows: UscfRow[] = [];
    const seenCategories = new Set<string>();
    for await (const row of scrapeUscf({
      maxCategories: opts.maxCategories,
      delayMs: opts.delayMs,
      nationwideOnly: opts.nationwideOnly,
      log,
    })) {
      allRows.push(row);
      seenCategories.add(row.sourceCategory);
    }

    log(
      `[uscf] scraping complete: ${allRows.length} rows across ${seenCategories.size} categories`,
    );

    const deduped = dedupeUscfRows(allRows);
    log(`[uscf] dedupe: ${allRows.length} → ${deduped.length} unique players`);

    const snapshotDate = new Date().toISOString().slice(0, 10);
    const upsertMetrics = await upsertUscfRows(sql, deduped, snapshotDate, log);

    const duration = (Date.now() - startedAt) / 1000;
    const metrics: IngestResult['metrics'] = {
      categories_scraped: seenCategories.size,
      rows_scraped: allRows.length,
      unique_players: deduped.length,
      ...upsertMetrics,
      duration_seconds: Math.round(duration),
    };

    await sql`
      UPDATE ingestion_runs
      SET status = 'completed', completed_at = NOW(), metrics = ${JSON.stringify(metrics)}::jsonb
      WHERE id = ${runId}
    `;

    log(`[uscf] run ${runId} completed in ${duration.toFixed(1)}s`);
    log(
      `[uscf] +${metrics.inserted} new, ${metrics.updated} updated, ` +
        `${metrics.skipped} unchanged, ${metrics.snapshots} snapshots`,
    );

    return { runId, metrics };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sql`
      UPDATE ingestion_runs
      SET status = 'failed', completed_at = NOW(), error = ${message}
      WHERE id = ${runId}
    `;
    throw err;
  }
}
