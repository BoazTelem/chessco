/**
 * Crawler watchdog — every 15 minutes, ensure a Cloud Run instance is
 * running per registered region as long as the queue has work.
 *
 * Algorithm (per platform):
 *   1. Read queue progress; if pending + error_retry == 0, skip.
 *   2. For each registered region:
 *      a. Look up most recent crawl-runs row for that worker_id.
 *      b. If last_heartbeat_at within 10 minutes → already running, skip.
 *      c. Otherwise → dispatch a Cloud Run execution.
 *   3. Log decisions so the Inngest dashboard shows the activity.
 *
 * Failure modes covered:
 *   - Cloud Run task exits on empty queue → watchdog re-dispatches when
 *     the 7-day refresh cron re-queues stale rows.
 *   - Cloud Run task crashes mid-run → stale-claim recovery resets the
 *     in-flight row; watchdog re-dispatches on the next tick.
 *   - GCP env vars not configured for a region → cloudRunJobFromEnv
 *     returns null, region is silently skipped (graceful).
 *
 * Manual trigger: chessco/crawler-watchdog.run.requested
 */
import { getGamesDb } from '../db.js';
import { inngest } from './client.js';
import { cloudRunJobFromEnv, dispatchCloudRunJob } from './cloud-run-jobs.js';
import { CHESSCOM_REGIONS, LICHESS_REGIONS, type CrawlerRegion } from './crawler-jobs.js';
import type postgres from 'postgres';

const STALE_HEARTBEAT_MINUTES = 10;

interface DispatchDecision {
  platform: 'chess.com' | 'lichess';
  workerId: string;
  decision: 'dispatched' | 'already-running' | 'no-work' | 'no-config';
  reason?: string;
}

async function evaluateAndDispatch(
  sql: postgres.Sql,
  platform: 'chess.com' | 'lichess',
  regions: CrawlerRegion[],
): Promise<DispatchDecision[]> {
  const decisions: DispatchDecision[] = [];

  // Queue check — if nothing pending, skip the whole platform.
  const table = platform === 'chess.com' ? 'chesscom_crawl_queue' : 'lichess_crawl_queue';
  const pending = await sql<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM ${sql(table)}
    WHERE status IN ('pending', 'error_retry')
      AND next_attempt_at <= NOW()
  `;
  const pendingCount = Number.parseInt(pending[0]!.n, 10);
  if (pendingCount === 0) {
    for (const r of regions) {
      decisions.push({ platform, workerId: r.workerId, decision: 'no-work' });
    }
    return decisions;
  }

  // Per-region heartbeat check.
  const runsTable = platform === 'chess.com' ? 'chesscom_crawl_runs' : 'lichess_crawl_runs';
  for (const region of regions) {
    const cfg = cloudRunJobFromEnv(region.envPrefix);
    if (!cfg) {
      decisions.push({
        platform,
        workerId: region.workerId,
        decision: 'no-config',
        reason: `missing ${region.envPrefix}_{PROJECT_ID,REGION,JOB_NAME} env`,
      });
      continue;
    }

    const recent = await sql<{ ago_minutes: string }[]>`
      SELECT EXTRACT(EPOCH FROM (NOW() - last_heartbeat_at)) / 60 AS ago_minutes
      FROM ${sql(runsTable)}
      WHERE worker_id = ${region.workerId}
        AND status = 'running'
      ORDER BY started_at DESC LIMIT 1
    `;
    const agoMinutes = recent.length > 0 ? Number.parseFloat(recent[0]!.ago_minutes) : Infinity;
    if (Number.isFinite(agoMinutes) && agoMinutes < STALE_HEARTBEAT_MINUTES) {
      decisions.push({
        platform,
        workerId: region.workerId,
        decision: 'already-running',
        reason: `last hb ${agoMinutes.toFixed(1)}m ago`,
      });
      continue;
    }

    // Stale or never-run → dispatch.
    await dispatchCloudRunJob(cfg, {
      envOverrides: { WORKER_ID: region.workerId },
    });
    decisions.push({ platform, workerId: region.workerId, decision: 'dispatched' });
  }

  return decisions;
}

export const crawlerWatchdog = inngest.createFunction(
  {
    id: 'crawler-watchdog',
    name: 'Crawler watchdog — dispatch Cloud Run jobs when needed',
    concurrency: { limit: 1 },
    retries: 1,
  },
  [{ cron: '*/15 * * * *' }, { event: 'chessco/crawler-watchdog.run.requested' }],
  async ({ logger }) => {
    const { client } = getGamesDb();
    try {
      const chesscomDecisions = await evaluateAndDispatch(client, 'chess.com', CHESSCOM_REGIONS);
      const lichessDecisions = await evaluateAndDispatch(client, 'lichess', LICHESS_REGIONS);
      const all = [...chesscomDecisions, ...lichessDecisions];
      for (const d of all) {
        logger.info(
          `[${d.platform.padEnd(10)}] ${d.workerId.padEnd(10)} ${d.decision}` +
            (d.reason ? ` (${d.reason})` : ''),
        );
      }
      return {
        dispatched: all.filter((d) => d.decision === 'dispatched').length,
        alreadyRunning: all.filter((d) => d.decision === 'already-running').length,
        noWork: all.filter((d) => d.decision === 'no-work').length,
        noConfig: all.filter((d) => d.decision === 'no-config').length,
      };
    } finally {
      await client.end({ timeout: 5 });
    }
  },
);
