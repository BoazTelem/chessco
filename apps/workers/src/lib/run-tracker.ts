/**
 * Shared `ingestion_runs` row management.
 *
 * Every federation worker inserts a row before scraping and updates it on
 * success/failure. Until 2026-05-14 this was duplicated across
 * `fide/ingest.ts`, `icf/ingest.ts`, `uscf/ingest.ts`. Phase 0 W7 expansion
 * promotes it to a shared lib so every new federation parser uses the same
 * `worker` column convention and metric shape.
 *
 * Wave-1 will migrate the existing three workers to call these helpers; until
 * then they continue to inline their own SQL.
 */
import type postgres from 'postgres';

export type TriggeredBy = 'cron' | 'admin' | 'cli' | string;

export async function openIngestionRun(
  sql: postgres.Sql,
  worker: string,
  triggeredBy: TriggeredBy = 'cli',
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO ingestion_runs (worker, status, triggered_by)
    VALUES (${worker}, 'running', ${triggeredBy})
    RETURNING id
  `;
  const first = rows[0];
  if (!first) throw new Error(`Failed to open ingestion_runs row for worker=${worker}`);
  return first.id;
}

export async function completeIngestionRun(
  sql: postgres.Sql,
  runId: string,
  metrics: Record<string, unknown>,
): Promise<void> {
  await sql`
    UPDATE ingestion_runs
    SET status = 'completed',
        completed_at = NOW(),
        metrics = ${JSON.stringify(metrics)}::jsonb
    WHERE id = ${runId}
  `;
}

export async function failIngestionRun(
  sql: postgres.Sql,
  runId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await sql`
    UPDATE ingestion_runs
    SET status = 'failed',
        completed_at = NOW(),
        error = ${message}
    WHERE id = ${runId}
  `;
}
