/**
 * ICF enrichment orchestrator.
 *
 * Strategy: pull a batch of ICF players whose rapid/blitz/title are NULL
 * (i.e. the rankings-list ingest didn't supply them), scrape the per-player
 * page, write the additional fields back. Re-runs are safe — every UPDATE
 * is a no-op when the data hasn't changed.
 *
 * Pagination is by `last_enriched_at` stored in `federation_players.raw`
 * — we touch the oldest-enriched (or never-enriched) rows first. ~6,800
 * ICF rows / 1 req/s ≈ 2 hours for a full pass. The Inngest cron runs
 * this monthly the day after the rankings ingest (`0 6 7 * *`) so the
 * second-step enrichment happens automatically.
 */
import type postgres from 'postgres';
import { fetchIcfPlayer, type IcfEnrichment } from './enrich-scrape.js';

export type EnrichOptions = {
  /** Hard cap on rows touched in one run. Default 1000 ≈ 16 min @ 1 req/s. */
  maxRows?: number;
  delayMs?: number;
  triggeredBy?: string;
  log?: (msg: string) => void;
};

export type EnrichResult = {
  runId: string;
  metrics: {
    rows_targeted: number;
    rows_fetched: number;
    rows_updated: number;
    rows_failed: number;
    duration_seconds: number;
  };
};

export async function runIcfEnrichment(
  sql: postgres.Sql,
  opts: EnrichOptions = {},
): Promise<EnrichResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const maxRows = opts.maxRows ?? 1000;
  const delayMs = opts.delayMs ?? 1000;
  const startedAt = Date.now();

  const runRows = await sql<{ id: string }[]>`
    INSERT INTO ingestion_runs (worker, status, triggered_by)
    VALUES ('icf-enrich', 'running', ${opts.triggeredBy ?? 'cli'})
    RETURNING id
  `;
  const runRow = runRows[0];
  if (!runRow) throw new Error('Failed to insert ingestion_runs row');
  const runId = runRow.id;
  log(`[icf-enrich] run ${runId} started — target ${maxRows} rows`);

  // Order: never-enriched first, then oldest-enriched.
  const targets = await sql<{ id: string; icf_id: string; last_enriched_at: string | null }[]>`
    SELECT
      id,
      federation_player_id AS icf_id,
      (raw->>'last_enriched_at') AS last_enriched_at
    FROM federation_players
    WHERE federation_id = 'ICF'
    ORDER BY (raw->>'last_enriched_at') NULLS FIRST, id
    LIMIT ${maxRows}
  `;

  log(`[icf-enrich] ${targets.length} rows queued`);

  let fetched = 0;
  let updated = 0;
  let failed = 0;

  try {
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!;
      let enrichment: IcfEnrichment | null = null;
      try {
        enrichment = await fetchIcfPlayer(t.icf_id);
        fetched++;
      } catch (err) {
        failed++;
        log(`[icf-enrich] icf=${t.icf_id} fetch error: ${(err as Error).message}`);
      }

      if (enrichment) {
        const enrichedRaw = {
          ...enrichment.raw,
          name_english: enrichment.nameEnglish,
          last_enriched_at: new Date().toISOString(),
        };
        await sql`
          UPDATE federation_players
          SET
            rating_rapid = COALESCE(${enrichment.ratingRapid}, rating_rapid),
            rating_blitz = COALESCE(${enrichment.ratingBlitz}, rating_blitz),
            title        = COALESCE(${enrichment.title}, title),
            birth_year   = COALESCE(${enrichment.birthYear}, birth_year),
            raw          = COALESCE(raw, '{}'::jsonb) || ${JSON.stringify(enrichedRaw)}::jsonb,
            last_updated_at = NOW()
          WHERE id = ${t.id}::uuid
        `;
        updated++;
      }

      if (i > 0 && i % 100 === 0) {
        log(`[icf-enrich]   …${i}/${targets.length} (${updated} updated, ${failed} failed)`);
      }
      if (i + 1 < targets.length && delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    const duration = (Date.now() - startedAt) / 1000;
    const metrics: EnrichResult['metrics'] = {
      rows_targeted: targets.length,
      rows_fetched: fetched,
      rows_updated: updated,
      rows_failed: failed,
      duration_seconds: Math.round(duration),
    };

    await sql`
      UPDATE ingestion_runs
      SET status = 'completed', completed_at = NOW(), metrics = ${JSON.stringify(metrics)}::jsonb
      WHERE id = ${runId}
    `;

    log(`[icf-enrich] run ${runId} completed in ${duration.toFixed(1)}s`);
    log(`[icf-enrich] ${updated} updated, ${failed} failed`);
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
