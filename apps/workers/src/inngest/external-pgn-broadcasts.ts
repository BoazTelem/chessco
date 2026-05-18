/**
 * Inngest cron — Lichess broadcasts auto-refresh.
 *
 * Turns the CLI-only broadcasts ingester (apps/workers/src/external-pgn/
 * lichess-broadcasts/ingest.ts) into a recurring task so the corpus stays
 * current automatically. Without this cron, broadcasts data only flows
 * when someone manually runs `pnpm external:broadcasts:ingest --tour X`.
 *
 * Cadence: every 30 minutes. Lichess broadcast rounds typically have one
 * game per board per ~3-5 hours of play; 30 min is a comfortable cadence
 * that picks up new moves during games without hammering the API. The
 * UNIQUE (source, source_url) constraint on external_pgn_sources means
 * each tick only inserts NEW games — already-staged games surface as
 * `conflicts` in the per-broadcast result, not as errors.
 *
 * Scope: limited to active (non-finished) broadcasts. We pull
 * /api/broadcast?nb=20 (the official-tournaments feed; tier-curated by
 * Lichess) and ingest each tournament that still has at least one round
 * not yet finished. This caps the per-tick work at ~20 tournaments ×
 * the games they've published; finished events are skipped entirely
 * (their games are already in staging from a previous tick).
 *
 * Failure mode: each tournament's ingest is wrapped in try/catch — one
 * broadcast going sideways (404, 5xx, parser hiccup) doesn't stop the
 * other broadcasts in the tick. Failed broadcasts get a logger.warn and
 * the cron returns counts so the run is observable.
 *
 * Manual trigger: chessco/external-pgn.broadcasts.refresh.requested.
 *   Useful when a major event starts and you want to force-pull before
 *   the next scheduled tick.
 */
import { getGamesDb } from '../db.js';
import { ingestBroadcastByTour } from '../external-pgn/lichess-broadcasts/ingest.js';
import { streamBroadcasts } from '../external-pgn/lichess-broadcasts/list.js';
import { inngest } from './client.js';

const LICHESS_BROADCAST_LIST = 'https://lichess.org/api/broadcast?nb=20';

interface PerTourResult {
  tour_id: string;
  inserted: number;
  conflicts: number;
  games_seen: number;
  error?: string;
}

export const broadcastsRefresh = inngest.createFunction(
  {
    id: 'external-pgn-broadcasts-refresh',
    name: 'External PGN — Lichess broadcasts live refresh (30 min)',
    concurrency: { limit: 1 },
    retries: 1,
  },
  [{ cron: '*/30 * * * *' }, { event: 'chessco/external-pgn.broadcasts.refresh.requested' }],
  async ({ logger }) => {
    const t0 = Date.now();
    const { client } = getGamesDb();
    const perTour: PerTourResult[] = [];
    try {
      // First pass: list active broadcasts. Anything with all rounds
      // finished is skipped — its games are already staged from a
      // previous tick (UNIQUE constraint handles dedup either way, but
      // skipping cuts the per-tick cost and the API requests).
      const active: { tourId: string; name: string }[] = [];
      for await (const entry of streamBroadcasts(LICHESS_BROADCAST_LIST)) {
        const anyLive = entry.rounds.some((r) => !r.finished);
        if (anyLive) active.push({ tourId: entry.tour.id, name: entry.tour.name });
      }
      logger.info(`broadcasts-refresh: ${active.length} active broadcasts in feed`);

      for (const { tourId, name } of active) {
        try {
          const r = await ingestBroadcastByTour(client, tourId);
          perTour.push({
            tour_id: tourId,
            inserted: r.inserted,
            conflicts: r.conflicts,
            games_seen: r.gamesSeen,
          });
          logger.info(
            `  ✓ ${tourId} (${name}): seen=${r.gamesSeen} inserted=${r.inserted} ` +
              `conflicts=${r.conflicts}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          perTour.push({
            tour_id: tourId,
            inserted: 0,
            conflicts: 0,
            games_seen: 0,
            error: msg,
          });
          logger.warn(`  ✗ ${tourId} (${name}): ${msg}`);
        }
      }
    } finally {
      await client.end({ timeout: 5 });
    }
    const elapsed = (Date.now() - t0) / 1000;
    const totalInserted = perTour.reduce((a, r) => a + r.inserted, 0);
    const totalConflicts = perTour.reduce((a, r) => a + r.conflicts, 0);
    const totalErrors = perTour.filter((r) => r.error).length;
    logger.info(
      `broadcasts-refresh: ${perTour.length} tours, ${totalInserted} new games, ` +
        `${totalConflicts} conflicts, ${totalErrors} errors, ${elapsed.toFixed(1)}s`,
    );
    return {
      tours: perTour.length,
      inserted: totalInserted,
      conflicts: totalConflicts,
      errors: totalErrors,
      elapsed_sec: elapsed,
    };
  },
);
