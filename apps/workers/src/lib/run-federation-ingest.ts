/**
 * Generic federation ingest orchestrator.
 *
 * Wires together: run-tracker + upsert-federation-players + a per-federation
 * pipeline (`fetch` → `parse` → optional `normalize`). Each Phase-B wave adds
 * a federation by writing a ~30-line `FederationIngestPipeline` and registering
 * it in `apps/workers/src/lib/federations/registry.ts`.
 *
 * The bodies of `fide/ingest.ts`, `icf/ingest.ts`, `uscf/ingest.ts` will be
 * replaced with calls to `runFederationIngest()` during Wave 1; until then
 * they keep their bespoke orchestrators.
 */
import type postgres from 'postgres';

import {
  completeIngestionRun,
  failIngestionRun,
  openIngestionRun,
  type TriggeredBy,
} from './run-tracker.js';
import {
  upsertFederationPlayers,
  type NormalizedFederationPlayerRow,
  type UpsertMetrics,
} from './upsert-federation-players.js';

export interface FederationIngestContext {
  /** federation_id (PK of the federations row, e.g. 'FIDE', 'USCF', 'ICF'). */
  code: string;
  /** ISO date string for the rating_snapshots row written this run. */
  snapshotDate: string;
  /** Standard log sink (also captured into ingestion_runs metrics). */
  log: (msg: string) => void;
  /** Aborted when the caller cancels (e.g. Inngest function timeout). */
  signal: AbortSignal;
}

export interface FederationIngestPipeline<TRaw> {
  /** Acquire raw rows from the source. Yield them so we can process in chunks. */
  fetch: (ctx: FederationIngestContext) => AsyncIterable<TRaw> | Promise<TRaw[]>;
  /**
   * Convert one source row into the normalized shape.
   * Return null to drop (e.g. missing required fields).
   */
  parse: (raw: TRaw, ctx: FederationIngestContext) => NormalizedFederationPlayerRow | null;
  /**
   * Optional post-pass: merge duplicates, dedupe by (federation_player_id), etc.
   * FIDE uses this to merge standard/rapid/blitz lists into one row per fideid.
   */
  normalize?: (
    rows: NormalizedFederationPlayerRow[],
    ctx: FederationIngestContext,
  ) => NormalizedFederationPlayerRow[];
  /** Pipeline-specific metrics to include in the ingestion_runs row. */
  extraMetrics?: () => Record<string, unknown>;
}

export interface RunFederationIngestOptions {
  triggeredBy?: TriggeredBy;
  log?: (msg: string) => void;
  signal?: AbortSignal;
  /** Override the snapshot date (default: today, UTC). */
  snapshotDate?: string;
  /** Override the worker name in ingestion_runs (default: lowercased `code`). */
  worker?: string;
}

export interface FederationIngestResult {
  runId: string;
  metrics: UpsertMetrics & {
    fetched: number;
    parsed: number;
    dropped: number;
    duration_seconds: number;
  } & Record<string, unknown>;
}

export async function runFederationIngest<TRaw>(
  sql: postgres.Sql,
  code: string,
  pipeline: FederationIngestPipeline<TRaw>,
  opts: RunFederationIngestOptions = {},
): Promise<FederationIngestResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const worker = opts.worker ?? code.toLowerCase();
  const snapshotDate = opts.snapshotDate ?? new Date().toISOString().slice(0, 10);
  const signal = opts.signal ?? new AbortController().signal;
  const startedAt = Date.now();

  const runId = await openIngestionRun(sql, worker, opts.triggeredBy ?? 'cli');
  log(`[${code}] run ${runId} started`);

  try {
    const ctx: FederationIngestContext = { code, snapshotDate, log, signal };

    // 1. Fetch + parse, accumulating normalized rows
    const fetched = await pipeline.fetch(ctx);
    const rows: NormalizedFederationPlayerRow[] = [];
    let fetchedCount = 0;
    let droppedCount = 0;

    const iter: AsyncIterable<TRaw> =
      Symbol.asyncIterator in Object(fetched)
        ? (fetched as AsyncIterable<TRaw>)
        : (async function* () {
            for (const r of fetched as TRaw[]) yield r;
          })();

    for await (const raw of iter) {
      if (signal.aborted) throw new Error('aborted');
      fetchedCount++;
      const normalized = pipeline.parse(raw, ctx);
      if (normalized) rows.push(normalized);
      else droppedCount++;
    }

    // 2. Optional dedupe/merge pass
    const finalRows = pipeline.normalize ? pipeline.normalize(rows, ctx) : rows;

    log(
      `[${code}] fetched=${fetchedCount} parsed=${rows.length} final=${finalRows.length} dropped=${droppedCount}`,
    );

    // 3. Upsert + snapshots
    const upsertMetrics = await upsertFederationPlayers(sql, code, finalRows, snapshotDate, log);

    const duration = (Date.now() - startedAt) / 1000;
    const metrics = {
      fetched: fetchedCount,
      parsed: rows.length,
      dropped: droppedCount,
      ...upsertMetrics,
      ...(pipeline.extraMetrics?.() ?? {}),
      duration_seconds: Math.round(duration),
    };

    await completeIngestionRun(sql, runId, metrics);

    // 4. Bump federations.last_synced_at so the UI banner shows fresh
    await sql`UPDATE federations SET last_synced_at = NOW() WHERE id = ${code}`;

    log(
      `[${code}] run ${runId} completed in ${duration.toFixed(1)}s ` +
        `(+${upsertMetrics.inserted} new, ${upsertMetrics.updated} updated, ` +
        `${upsertMetrics.skipped} unchanged, ${upsertMetrics.snapshots} snapshots)`,
    );

    return { runId, metrics };
  } catch (err) {
    await failIngestionRun(sql, runId, err);
    throw err;
  }
}
