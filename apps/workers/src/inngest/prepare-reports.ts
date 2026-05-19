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
import {
  buildAndPersist,
  lookupHandleId,
  existingRepertoireCombos,
  latestGamePlayedAt,
} from '../repertoires/build.js';
import { runScopedBackfillForHandle } from '../stockfish/backfill.js';
import { seedHandles as seedChesscomHandles } from '../chesscom-crawl/queue.js';
import { inngest } from './client.js';

const REPERTOIRE_DEPTH = 12;
const COVERAGE_THRESHOLD = 0.7; // 70% of recent moves must have cp_loss
const RECENT_GAMES_FOR_COVERAGE = 100;
const BATCH_LIMIT = 5; // reports per tick; each one can be slow (Stockfish)

// Staleness rules for cached repertoires:
//  · If any game in the corpus is newer than the all-time bucket_until by
//    more than STALENESS_GRACE_MS, rebuild. Grace prevents thrashing when
//    a target plays a game and the user refreshes immediately.
//  · If the all-time bucket's built_at is older than ROLLING_BUCKET_MAX_AGE_MS
//    with no new games, rebuild anyway — the rolling buckets (recent_3mo etc.)
//    silently drift past their window otherwise.
const STALENESS_GRACE_MS = 60 * 60 * 1000; // 1 hour
const ROLLING_BUCKET_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
  logger?: { info: (msg: string) => void };
}): Promise<{
  status: 'built' | 'unknown_handle';
  whiteGames: number;
  blackGames: number;
  rebuilt: boolean;
  reason?: 'missing' | 'new_games' | 'rolling_bucket_age';
}> {
  const lookup = await lookupHandleId(args.games, args.platform, args.handle);
  if (!lookup) {
    return { status: 'unknown_handle', whiteGames: 0, blackGames: 0, rebuilt: false };
  }

  const existing = await existingRepertoireCombos(args.games, lookup.id, REPERTOIRE_DEPTH);
  const haveWhite = existing.some((r) => r.color === 'white');
  const haveBlack = existing.some((r) => r.color === 'black');

  // Decide whether to (re)build. Three reasons:
  //  1. missing — at least one color has no row at this depth
  //  2. new_games — corpus has games newer than the all-time bucket_until
  //  3. rolling_bucket_age — the all-time row is older than the rolling
  //     window cap, so recent_3mo/recent_12mo are silently drifting
  let reason: 'missing' | 'new_games' | 'rolling_bucket_age' | null = null;
  if (!haveWhite || !haveBlack) {
    reason = 'missing';
  } else {
    // Pick the all_time row per color — it has the widest bucket_until
    // (= NOW() at build time). If only rolling buckets exist (shouldn't
    // happen given buildAndPersist writes them all), fall back to the
    // newest bucket_until across all rows of that color.
    const newestBucketUntil = (color: 'white' | 'black'): Date | null => {
      const rows = existing.filter((r) => r.color === color && r.bucket_until !== null);
      if (rows.length === 0) return null;
      let max = rows[0]!.bucket_until!;
      for (const r of rows) if (r.bucket_until! > max) max = r.bucket_until!;
      return max;
    };
    const oldestBuiltAt = (color: 'white' | 'black'): Date | null => {
      const rows = existing.filter((r) => r.color === color);
      if (rows.length === 0) return null;
      let min = rows[0]!.built_at;
      for (const r of rows) if (r.built_at < min) min = r.built_at;
      return min;
    };

    const whiteUntil = newestBucketUntil('white');
    const blackUntil = newestBucketUntil('black');
    const minUntil =
      whiteUntil && blackUntil
        ? whiteUntil < blackUntil
          ? whiteUntil
          : blackUntil
        : (whiteUntil ?? blackUntil);

    const latest = await latestGamePlayedAt(args.games, args.platform, args.handle);
    if (latest && minUntil && latest.getTime() > minUntil.getTime() + STALENESS_GRACE_MS) {
      reason = 'new_games';
    } else {
      const whiteAge = oldestBuiltAt('white');
      const blackAge = oldestBuiltAt('black');
      const oldestAge =
        whiteAge && blackAge ? (whiteAge < blackAge ? whiteAge : blackAge) : (whiteAge ?? blackAge);
      if (oldestAge && Date.now() - oldestAge.getTime() > ROLLING_BUCKET_MAX_AGE_MS) {
        reason = 'rolling_bucket_age';
      }
    }
  }

  if (!reason) {
    return { status: 'built', whiteGames: 0, blackGames: 0, rebuilt: false };
  }

  args.logger?.info(
    `[ensureRepertoires] ${args.platform}/${args.handle} rebuilding (reason=${reason})`,
  );
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
    rebuilt: true,
    reason,
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
      logger,
    });
    if (opp.status === 'unknown_handle') {
      // Lichess opponents that aren't in the corpus can't be on-demand
      // crawled (see [docs/INCIDENT-2026-05-18-lichess-ip-block.md]).
      // They'll appear after the next monthly dump scan; until then,
      // surface a clear failure rather than spin in data_pending.
      if (report.target_platform === 'lichess') {
        logger.warn(
          `[prepare-reports ${report.id.slice(0, 8)}] opponent lichess/` +
            `${report.target_handle_normalized} not in corpus; Lichess opponents arrive ` +
            `via monthly dumps, not on-demand`,
        );
        return { status: 'failed', error: 'opponent_not_in_corpus_lichess_dumps_only' };
      }

      // chess.com: auto-enqueue and stay in data_pending so the next poll
      // tick re-checks once the Cloud Run crawler fills their games.
      const ageMin = report.age_seconds / 60;
      if (ageMin > UNKNOWN_HANDLE_TIMEOUT_MIN) {
        logger.warn(
          `[prepare-reports ${report.id.slice(0, 8)}] opponent chess.com/` +
            `${report.target_handle_normalized} not crawled after ${ageMin.toFixed(0)}m — giving up`,
        );
        return { status: 'failed', error: 'opponent_not_in_corpus' };
      }
      const inserted = await seedChesscomHandles(
        games,
        [report.target_handle_normalized],
        ON_DEMAND_CRAWL_PRIORITY,
      );
      logger.info(
        `[prepare-reports ${report.id.slice(0, 8)}] enqueued chess.com/` +
          `${report.target_handle_normalized} for crawl (${inserted === 1 ? 'new' : 'already queued'}); ` +
          `report will retry next tick (age=${ageMin.toFixed(1)}m)`,
      );
      return { status: 'data_pending' };
    }

    // 2. Ensure user repertoires for each linked account. If any of the
    //    user's linked handles isn't in the corpus, mirror step-1: enqueue
    //    a crawl and stay in data_pending so the next tick re-checks.
    //    Without this, an empty user repertoire silently slips through and
    //    every leak ends up in the trivial scoreSurprise fallback.
    const unknownLichess: string[] = [];
    const unknownChesscom: string[] = [];
    for (const acc of linked) {
      const res = await ensureRepertoires({
        games,
        platform: acc.platform,
        handle: acc.external_id,
        logger,
      });
      if (res.status === 'unknown_handle') {
        if (acc.platform === 'lichess') unknownLichess.push(acc.external_id);
        else unknownChesscom.push(acc.external_id);
      }
    }
    if (unknownLichess.length > 0 || unknownChesscom.length > 0) {
      // Lichess handles can't be on-demand crawled — surface failure
      // immediately so the user sees a clear error rather than infinite
      // data_pending. The fix is for the user's Lichess account to land
      // in the next monthly dump scan (they will, since they're rated).
      if (unknownLichess.length > 0) {
        logger.warn(
          `[prepare-reports ${report.id.slice(0, 8)}] user has linked Lichess handle(s) ` +
            `not yet in corpus: ${unknownLichess.join(', ')}; Lichess corpus updates monthly`,
        );
        return { status: 'failed', error: 'user_lichess_handle_not_in_corpus_yet' };
      }

      const ageMin = report.age_seconds / 60;
      if (ageMin > UNKNOWN_HANDLE_TIMEOUT_MIN) {
        logger.warn(
          `[prepare-reports ${report.id.slice(0, 8)}] user chess.com handle(s) not crawled ` +
            `after ${ageMin.toFixed(0)}m — giving up`,
        );
        return { status: 'failed', error: 'user_handles_not_in_corpus' };
      }
      await seedChesscomHandles(games, unknownChesscom, ON_DEMAND_CRAWL_PRIORITY);
      logger.info(
        `[prepare-reports ${report.id.slice(0, 8)}] enqueued ${unknownChesscom.length} ` +
          `user chess.com handle(s) for crawl; report will retry next tick (age=${ageMin.toFixed(1)}m)`,
      );
      return { status: 'data_pending' };
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
