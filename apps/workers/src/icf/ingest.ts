/**
 * ICF ingestion orchestrator.
 */
import type postgres from 'postgres';
import { scrapeAllPages, type IcfRow } from './scrape.js';
import { upsertIcfRows } from './upsert.js';

export type IngestOptions = {
  maxPages?: number;
  delayMs?: number;
  triggeredBy?: string;
  log?: (msg: string) => void;
};

export type IngestResult = {
  runId: string;
  metrics: {
    pages_fetched: number;
    rows_scraped: number;
    inserted: number;
    updated: number;
    skipped: number;
    snapshots: number;
    duration_seconds: number;
  };
};

export async function runIcfIngest(
  sql: postgres.Sql,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const startedAt = Date.now();

  const runRows = await sql<{ id: string }[]>`
    INSERT INTO ingestion_runs (worker, status, triggered_by)
    VALUES ('icf', 'running', ${opts.triggeredBy ?? 'cli'})
    RETURNING id
  `;
  const firstRow = runRows[0];
  if (!firstRow) throw new Error('Failed to insert ingestion_runs row');
  const runId = firstRow.id;
  log(`[icf] run ${runId} started`);

  try {
    const rows: IcfRow[] = [];
    let pageCount = 0;
    let lastReportedSize = 0;

    for await (const row of scrapeAllPages({
      maxPages: opts.maxPages,
      delayMs: opts.delayMs,
      log,
    })) {
      rows.push(row);
      // 100 per page; bump page count when we cross a multiple of 100
      if (Math.floor(rows.length / 100) > Math.floor(lastReportedSize / 100)) {
        pageCount = Math.floor(rows.length / 100);
      }
      lastReportedSize = rows.length;
    }

    log(`[icf] scraping complete: ${rows.length} rows across ${pageCount}+ pages`);

    const snapshotDate = new Date().toISOString().slice(0, 10);
    const upsertMetrics = await upsertIcfRows(sql, rows, snapshotDate, log);

    const duration = (Date.now() - startedAt) / 1000;
    const metrics: IngestResult['metrics'] = {
      pages_fetched: pageCount,
      rows_scraped: rows.length,
      ...upsertMetrics,
      duration_seconds: Math.round(duration),
    };

    await sql`
      UPDATE ingestion_runs
      SET status = 'completed', completed_at = NOW(), metrics = ${JSON.stringify(metrics)}::jsonb
      WHERE id = ${runId}
    `;

    log(`[icf] run ${runId} completed in ${duration.toFixed(1)}s`);
    log(
      `[icf] +${metrics.inserted} new, ${metrics.updated} updated, ` +
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
