/**
 * Personalized Leaks — data readiness poller.
 *
 * Watches Supabase `prep_reports` for rows with status='data_pending' and
 * ensures the games-corpus side has what the leaks scorer needs:
 *   1. Opponent's player_repertoires (both colors) exist at depth 12+.
 *   2. The user's linked-account player_repertoires exist.
 *   3. The opponent's recent games have per-move cp_loss populated.
 *
 * Once all three pass, flip status='ready'. Leak scoring itself happens
 * on-demand the first time the web app's GET endpoint serves the report;
 * the computed leaks_json is then cached on the row.
 *
 * Cron: every 30 seconds.
 * Manual: fire `chessco/prepare-reports.poll.requested` event.
 */
import postgres from 'postgres';
import { getDb, getGamesDb } from '../db.js';
import { buildAndPersist, lookupHandleId, existingRepertoireCombos } from '../repertoires/build.js';
import { runScopedBackfillForHandle } from '../stockfish/backfill.js';
import { seedHandles as seedChesscomHandles } from '../chesscom-crawl/queue.js';
import { seedHandles as seedLichessHandles } from '../lichess-crawl/queue.js';
import { inngest } from './client.js';

const REPERTOIRE_DEPTH = 12;
const COVERAGE_THRESHOLD = 0.7; // 70% of recent moves must have cp_loss
const RECENT_GAMES_FOR_COVERAGE = 100;
const BATCH_LIMIT = 5; // reports per tick; each one can be slow (Stockfish)

// Priority floor for opponents enqueued on cache miss — user-driven, so they
// jump ahead of bulk backfill (priority 0). Stays below any future
// "premium-tier" tier (>=200) if we add one.
const ON_DEMAND_CRAWL_PRIORITY = 100;
// Cap how long a report stays in data_pending waiting for a crawler. After
// this many minutes since created_at, give up and surface the failure.
const UNKNOWN_HANDLE_TIMEOUT_MIN = 60;

interface PendingReport {
  id: string;
  requested_by: string;
  target_platform: 'lichess' | 'chess.com';
  target_handle_normalized: string;
  /** Seconds since the report was first created — used to gate the
   *  unknown-handle wait so we don't loop forever. */
  age_seconds: number;
}

interface LinkedAccount {
  platform: 'lichess' | 'chess.com';
  external_id: string;
}

/**
 * Atomically claim up to BATCH_LIMIT reports by flipping status from
 * 'data_pending' to 'building'. The inner SELECT uses FOR UPDATE SKIP
 * LOCKED so concurrent pollers don't double-process the same row. Once
 * claimed, the row is processed outside any transaction (Stockfish work
 * is too long to hold a tx open for).
 */
async function claimPending(supa: postgres.Sql): Promise<PendingReport[]> {
  return supa<PendingReport[]>`
    UPDATE prep_reports
    SET status = 'building'
    WHERE id IN (
      SELECT id FROM prep_reports
      WHERE status = 'data_pending'
        AND target_platform IS NOT NULL
        AND target_handle_normalized IS NOT NULL
      ORDER BY created_at
      LIMIT ${BATCH_LIMIT}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id::text, requested_by::text, target_platform, target_handle_normalized,
              EXTRACT(EPOCH FROM (NOW() - created_at))::int AS age_seconds
  `;
}

async function fetchLinkedAccounts(
  supa: postgres.Sql,
  profileId: string,
): Promise<LinkedAccount[]> {
  return supa<LinkedAccount[]>`
    SELECT platform, external_id
    FROM external_accounts
    WHERE profile_id = ${profileId}
      AND platform IN ('lichess', 'chess.com')
      AND verified = true
  `;
}

async function ensureRepertoires(args: {
  games: postgres.Sql;
  platform: 'lichess' | 'chess.com';
  handle: string;
}): Promise<{ status: 'built' | 'unknown_handle'; whiteGames: number; blackGames: number }> {
  const lookup = await lookupHandleId(args.games, args.platform, args.handle);
  if (!lookup) return { status: 'unknown_handle', whiteGames: 0, blackGames: 0 };

  const existing = await existingRepertoireCombos(args.games, lookup.id, REPERTOIRE_DEPTH);
  const haveWhite = existing.some((r) => r.color === 'white');
  const haveBlack = existing.some((r) => r.color === 'black');
  if (haveWhite && haveBlack) {
    return { status: 'built', whiteGames: 0, blackGames: 0 };
  }
  const stats = await buildAndPersist(
    args.games,
    lookup.id,
    lookup.platform,
    lookup.handle,
    REPERTOIRE_DEPTH,
  );
  return {
    status: 'built',
    whiteGames: stats.games_white,
    blackGames: stats.games_black,
  };
}

async function checkCoverage(args: {
  games: postgres.Sql;
  platform: 'lichess' | 'chess.com';
  handle: string;
}): Promise<{ coverage: number; totalMoves: number; withCpLoss: number }> {
  const handleLower = args.handle.toLowerCase();
  // UNION ALL keeps the planner using games_white_handle_snap_idx /
  // games_black_handle_snap_idx (added by games-corpus migration 0012).
  const rows = await args.games<{ total_moves: number; with_cp_loss: number }[]>`
    WITH target_games AS (
      SELECT id FROM (
        (SELECT g.id, g.played_at FROM games g
          WHERE g.source = ${args.platform}
            AND LOWER(g.white_handle_snapshot) = ${handleLower}
          ORDER BY g.played_at DESC LIMIT ${RECENT_GAMES_FOR_COVERAGE})
        UNION ALL
        (SELECT g.id, g.played_at FROM games g
          WHERE g.source = ${args.platform}
            AND LOWER(g.black_handle_snapshot) = ${handleLower}
          ORDER BY g.played_at DESC LIMIT ${RECENT_GAMES_FOR_COVERAGE})
      ) x
      ORDER BY played_at DESC LIMIT ${RECENT_GAMES_FOR_COVERAGE}
    )
    SELECT
      COUNT(*)::int AS total_moves,
      COUNT(*) FILTER (WHERE m.cp_loss IS NOT NULL)::int AS with_cp_loss
    FROM moves m
    WHERE m.game_id IN (SELECT id FROM target_games)
      AND m.ply BETWEEN 1 AND 60
  `;
  const row = rows[0] ?? { total_moves: 0, with_cp_loss: 0 };
  return {
    coverage: row.total_moves > 0 ? row.with_cp_loss / row.total_moves : 0,
    totalMoves: row.total_moves,
    withCpLoss: row.with_cp_loss,
  };
}

async function processReport(
  supa: postgres.Sql,
  games: postgres.Sql,
  report: PendingReport,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<{ status: 'ready' | 'data_pending' | 'failed'; error?: string }> {
  try {
    const linked = await fetchLinkedAccounts(supa, report.requested_by);
    if (linked.length === 0) {
      return { status: 'failed', error: 'no_linked_accounts' };
    }

    // 1. Ensure opponent repertoires.
    const opp = await ensureRepertoires({
      games,
      platform: report.target_platform,
      handle: report.target_handle_normalized,
    });
    if (opp.status === 'unknown_handle') {
      // Handle isn't in the corpus yet. Auto-enqueue a crawl and keep the
      // report in data_pending so the next poll tick can re-check once the
      // platform crawler has filled in their games. Gate by an age cap so
      // we surface a real failure if the crawler never catches up.
      const ageMin = report.age_seconds / 60;
      if (ageMin > UNKNOWN_HANDLE_TIMEOUT_MIN) {
        logger.warn(
          `[prepare-reports ${report.id.slice(0, 8)}] opponent ${report.target_platform}/` +
            `${report.target_handle_normalized} not crawled after ${ageMin.toFixed(0)}m — giving up`,
        );
        return { status: 'failed', error: 'opponent_not_in_corpus' };
      }
      const seed =
        report.target_platform === 'chess.com' ? seedChesscomHandles : seedLichessHandles;
      const inserted = await seed(
        games,
        [report.target_handle_normalized],
        ON_DEMAND_CRAWL_PRIORITY,
      );
      logger.info(
        `[prepare-reports ${report.id.slice(0, 8)}] enqueued ${report.target_platform}/` +
          `${report.target_handle_normalized} for crawl (${inserted === 1 ? 'new' : 'already queued'}); ` +
          `report will retry next tick (age=${ageMin.toFixed(1)}m)`,
      );
      return { status: 'data_pending' };
    }

    // 2. Ensure user repertoires for each linked account.
    for (const acc of linked) {
      await ensureRepertoires({
        games,
        platform: acc.platform,
        handle: acc.external_id,
      });
    }

    // 3. Check Stockfish coverage on opponent's recent games. If low, run
    //    the scoped per-handle backfill to fill it in.
    const coverage = await checkCoverage({
      games,
      platform: report.target_platform,
      handle: report.target_handle_normalized,
    });
    logger.info(
      `[prepare-reports ${report.id.slice(0, 8)}] coverage=${(coverage.coverage * 100).toFixed(1)}% ` +
        `(${coverage.withCpLoss}/${coverage.totalMoves}) on ${report.target_platform}/${report.target_handle_normalized}`,
    );
    if (coverage.coverage < COVERAGE_THRESHOLD) {
      logger.info(`[prepare-reports ${report.id.slice(0, 8)}] running Stockfish backfill…`);
      const stats = await runScopedBackfillForHandle({
        platform: report.target_platform,
        handle: report.target_handle_normalized,
        limit: RECENT_GAMES_FOR_COVERAGE,
        startPly: 1,
        endPly: 60,
        workers: 2,
        depth: 10,
      });
      logger.info(
        `[prepare-reports ${report.id.slice(0, 8)}] backfill: ${stats.totalAnalyzed} games, ${stats.moveUpdates} moves in ${stats.elapsedSec.toFixed(1)}s`,
      );
    }

    return { status: 'ready' };
  } catch (err) {
    return { status: 'failed', error: (err as Error).message };
  }
}

async function pollOnce(logger: {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}): Promise<{ processed: number; ready: number; failed: number; pending: number }> {
  const { client: supa } = getDb();
  const { client: games } = getGamesDb();
  try {
    const claimed = await claimPending(supa);
    let ready = 0;
    let failed = 0;
    let pending = 0;
    for (const report of claimed) {
      const result = await processReport(supa, games, report, logger);
      if (result.status === 'ready') {
        await supa`
          UPDATE prep_reports
          SET status = 'ready', completed_at = NOW(), error_text = NULL
          WHERE id = ${report.id}::uuid
        `;
        ready += 1;
      } else if (result.status === 'data_pending') {
        // Crawl-in-flight or other transient wait — release the claim so
        // the next tick picks it up. completed_at stays NULL.
        await supa`
          UPDATE prep_reports
          SET status = 'data_pending', error_text = NULL
          WHERE id = ${report.id}::uuid
        `;
        pending += 1;
      } else {
        await supa`
          UPDATE prep_reports
          SET status = 'failed', error_text = ${result.error ?? 'unknown'}
          WHERE id = ${report.id}::uuid
        `;
        failed += 1;
      }
    }
    return { processed: claimed.length, ready, failed, pending };
  } finally {
    await games.end({ timeout: 5 }).catch(() => undefined);
    await supa.end({ timeout: 5 }).catch(() => undefined);
  }
}

export const prepareReportsPoll = inngest.createFunction(
  {
    id: 'prepare-reports-poll',
    name: 'Personalized Leaks — data-readiness poller',
    concurrency: { limit: 1 },
    retries: 1,
  },
  // Inngest's minimum cron resolution is 1 minute (the original 6-field
  // `*/30 * * * * *` "every 30 seconds" was rejected at sync time).
  [{ cron: '* * * * *' }, { event: 'chessco/prepare-reports.poll.requested' }],
  async ({ logger }) => {
    const out = await pollOnce(logger);
    logger.info(
      `[prepare-reports] tick: processed=${out.processed} ready=${out.ready} ` +
        `pending=${out.pending} failed=${out.failed}`,
    );
    return out;
  },
);
