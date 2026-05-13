/**
 * Federation ingestion cron functions.
 *
 * Each federation registers one scheduled Inngest function with the cron
 * expression locked in docs/PLAN.md ("Federation cron registry").
 *
 * The schedules stagger across the month so workers never overlap:
 *   FIDE  — 5th  of month, 04:00 UTC
 *   ICF   — 6th  of month, 05:00 UTC
 *   USCF  — 7th  of month, 06:00 UTC
 *   ECF…  — 8th  of month, 07:00 UTC (Phase 1 W1)
 *   etc.
 *
 * Every function:
 *   1. Opens a `postgres` client to Supabase via getDb()
 *   2. Calls the existing orchestrator (runFideIngest / runIcfIngest / runUscfIngest)
 *      which already manages an `ingestion_runs` row.
 *   3. Returns the run metrics so the Inngest dashboard surfaces them.
 *
 * Triggered manually via Inngest `events.sendEvent('chessco/<fed>.ingest.requested')`
 * (also used by the admin UI button).
 */
import { inngest } from './client.js';
import { getDb } from '../db.js';
import { runFideIngest } from '../fide/ingest.js';
import { runIcfIngest } from '../icf/ingest.js';
import { runIcfEnrichment } from '../icf/enrich.js';
import { runUscfIngest } from '../uscf/ingest.js';
import { cloudRunJobFromEnv, dispatchCloudRunJob } from './cloud-run-jobs.js';

export const fideMonthly = inngest.createFunction(
  {
    id: 'fide-monthly-ingest',
    name: 'FIDE — monthly ratings ingest',
    concurrency: { limit: 1 },
    retries: 3,
  },
  [{ cron: '0 4 5 * *' }, { event: 'chessco/fide.ingest.requested' }],
  async ({ event, logger }) => {
    const { client } = getDb();
    try {
      const result = await runFideIngest(client, {
        triggeredBy: event?.name?.includes('requested') ? 'admin' : 'cron',
        log: (m) => logger.info(m),
      });
      return result;
    } finally {
      await client.end();
    }
  },
);

export const icfMonthly = inngest.createFunction(
  {
    id: 'icf-monthly-ingest',
    name: 'ICF — monthly ratings ingest',
    concurrency: { limit: 1 },
    retries: 3,
  },
  [{ cron: '0 5 6 * *' }, { event: 'chessco/icf.ingest.requested' }],
  async ({ event, logger }) => {
    const { client } = getDb();
    try {
      const result = await runIcfIngest(client, {
        triggeredBy: event?.name?.includes('requested') ? 'admin' : 'cron',
        log: (m) => logger.info(m),
      });
      return result;
    } finally {
      await client.end();
    }
  },
);

/**
 * Per-player ICF enrichment runs the day after the rankings list ingest.
 * Day 7 at 04:00 UTC keeps it on the same 24-hour staircase as the other
 * federation crons. The orchestrator caps the run at 1000 rows so each
 * tick finishes in ~16 minutes; a full ICF corpus (~7k rows) needs
 * ~7 ticks to enrich fully. The orchestrator targets never-enriched rows
 * first, so successive ticks naturally walk the corpus.
 */
export const icfEnrichmentDaily = inngest.createFunction(
  {
    id: 'icf-enrichment-daily',
    name: 'ICF — per-player enrichment crawl',
    concurrency: { limit: 1 },
    retries: 2,
  },
  [{ cron: '0 4 * * *' }, { event: 'chessco/icf.enrich.requested' }],
  async ({ event, logger }) => {
    const { client } = getDb();
    try {
      const result = await runIcfEnrichment(client, {
        maxRows: 1000,
        triggeredBy: event?.name?.includes('requested') ? 'admin' : 'cron',
        log: (m) => logger.info(m),
      });
      return result;
    } finally {
      await client.end();
    }
  },
);

/**
 * USCF dispatch: when USCF_CLOUD_RUN_JOB_NAME is set in env, the cron
 * tick fires off the dedicated Playwright Cloud Run job and returns
 * immediately. The job writes its own `ingestion_runs` row, so we don't
 * need to wait for completion — the admin dashboard can read run history
 * directly. Falls back to inline (`runUscfIngest` in this process) when
 * Cloud Run isn't configured, useful for local dev.
 */
export const uscfMonthly = inngest.createFunction(
  {
    id: 'uscf-monthly-ingest',
    name: 'USCF — monthly top-list ingest (Playwright)',
    concurrency: { limit: 1 },
    retries: 2,
  },
  [{ cron: '0 6 7 * *' }, { event: 'chessco/uscf.ingest.requested' }],
  async ({ event, logger }) => {
    const triggeredBy = event?.name?.includes('requested') ? 'admin' : 'cron';
    const jobRef = cloudRunJobFromEnv('USCF_CLOUD_RUN');

    if (jobRef) {
      logger.info(`[uscf] dispatching to Cloud Run job ${jobRef.jobName}`);
      const { operationName } = await dispatchCloudRunJob(jobRef, {
        envOverrides: { TRIGGERED_BY: triggeredBy },
      });
      return { dispatched: true, operationName };
    }

    logger.info(`[uscf] no Cloud Run job configured — running inline`);
    const { client } = getDb();
    try {
      const result = await runUscfIngest(client, {
        triggeredBy,
        log: (m) => logger.info(m),
      });
      return result;
    } finally {
      await client.end();
    }
  },
);

export const federationFunctions = [
  fideMonthly,
  icfMonthly,
  icfEnrichmentDaily,
  uscfMonthly,
] as const;
