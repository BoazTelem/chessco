/**
 * FIDE ingestion orchestrator.
 *
 * Steps:
 *   1. Insert ingestion_runs row (status='running')
 *   2. Download 3 zip files
 *   3. For each: stream-parse, merge into in-memory map
 *   4. Bulk-upsert merged records
 *   5. Update ingestion_runs row (status='completed' + metrics)
 */
import type postgres from 'postgres';
import { downloadAll, openXmlStream, type RatingClass } from './download.js';
import { parseFideStream } from './parse.js';
import { mergePlayer, upsertMerged, type MergedRecord } from './upsert.js';

export type IngestOptions = {
  /** When set, truncates parse to this many players per file. Used for smoke testing. */
  maxPlayers?: number;
  /** Who triggered the run. */
  triggeredBy?: string;
  /** Logger; defaults to console.log. */
  log?: (msg: string) => void;
};

export type IngestResult = {
  runId: string;
  metrics: {
    downloaded_bytes: number;
    parsed: Record<RatingClass, number>;
    unique_players: number;
    inserted: number;
    updated: number;
    skipped: number;
    snapshots: number;
    parse_errors: number;
    duration_seconds: number;
  };
};

export async function runFideIngest(
  sql: postgres.Sql,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const startedAt = Date.now();

  // Open the run row.
  const runRows = await sql<{ id: string }[]>`
    INSERT INTO ingestion_runs (worker, status, triggered_by)
    VALUES ('fide', 'running', ${opts.triggeredBy ?? 'cli'})
    RETURNING id
  `;
  const firstRow = runRows[0];
  if (!firstRow) throw new Error('Failed to insert ingestion_runs row');
  const runId = firstRow.id;
  log(`[fide] run ${runId} started`);

  try {
    // 1. Download
    const { files, bytes, cleanupAll } = await downloadAll({ log });

    // 2. Stream-parse and merge
    const merged = new Map<string, MergedRecord>();
    const parsed: Record<RatingClass, number> = { standard: 0, rapid: 0, blitz: 0 };
    let parseErrors = 0;

    for (const file of files) {
      log(`[fide] parsing ${file.ratingClass} list…`);
      const stream = await openXmlStream(file.zipPath);
      const result = await parseFideStream(
        stream,
        (p) => {
          mergePlayer(merged, p, file.ratingClass);
        },
        {
          maxPlayers: opts.maxPlayers,
          onError: (e) => {
            parseErrors++;
            if (parseErrors <= 5) log(`[fide] parse warning: ${e.message}`);
          },
        },
      );
      parsed[file.ratingClass] = result.parsed;
      log(`[fide] ${file.ratingClass}: parsed ${result.parsed} players`);
    }

    // 3. Upsert
    const snapshotDate = new Date().toISOString().slice(0, 10);
    const records = Array.from(merged.values());
    const upsertMetrics = await upsertMerged(sql, records, snapshotDate, log);

    // 4. Cleanup temp files
    await cleanupAll();

    const duration = (Date.now() - startedAt) / 1000;
    const metrics: IngestResult['metrics'] = {
      downloaded_bytes: bytes,
      parsed,
      unique_players: records.length,
      ...upsertMetrics,
      parse_errors: parseErrors,
      duration_seconds: Math.round(duration),
    };

    await sql`
      UPDATE ingestion_runs
      SET status = 'completed', completed_at = NOW(), metrics = ${JSON.stringify(metrics)}::jsonb
      WHERE id = ${runId}
    `;

    log(`[fide] run ${runId} completed in ${duration.toFixed(1)}s`);
    log(
      `[fide] +${metrics.inserted} new, ${metrics.updated} updated, ` +
        `${metrics.skipped} unchanged, ${metrics.snapshots} snapshots, ` +
        `${metrics.parse_errors} parse errors`,
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
