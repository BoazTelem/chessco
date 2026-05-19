/**
 * Scout-ready evaluator — Phase 1 of the player-identification pipeline.
 *
 * A handle is "scout-ready" when we believe we have a complete-enough view
 * of their games for downstream stages:
 *   - chess.com: every chesscom_crawl_queue row for the handle has
 *     status='done' AND ≥1 archive_month row exists (proves expansion ran).
 *   - lichess:   the handle has ≥1 game with source='lichess' in the
 *     games corpus. Lichess coverage comes from monthly dumps, not a
 *     per-handle queue (see [docs/INCIDENT-2026-05-18-lichess-ip-block.md]),
 *     so presence-in-corpus is the strongest signal available — when a new
 *     monthly dump arrives, more games appear automatically.
 *
 * When a handle becomes ready, we UPSERT it into the canonical `handles`
 * table (computing games_seen / first_seen_at / last_seen_at from the
 * games table) and stamp scout_ready_at. handles will grow naturally to
 * cover every accounted-for player.
 *
 * CLI usage (one-shot backfill — scan all known handles, mark all that
 * qualify):
 *   tsx src/identification/scout-ready.ts
 *
 * Hooked from chesscom-crawl/run.ts after each completeItem, and from
 * lichess-dumps/run.ts after each dump finishes ingesting.
 */
import 'dotenv/config';
import type postgres from 'postgres';
import { getGamesDb } from '../db';

export type Platform = 'chess.com' | 'lichess';

export async function isChesscomHandleReady(sql: postgres.Sql, handle: string): Promise<boolean> {
  const lower = handle.toLowerCase();
  // No row in any non-done status => candidate. Then require at least
  // one archive_month row (proves the archives_list expanded).
  const incomplete = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM chesscom_crawl_queue
    WHERE LOWER(handle) = ${lower} AND status != 'done'
  `;
  if (Number(incomplete[0]!.count) > 0) return false;
  const months = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM chesscom_crawl_queue
    WHERE LOWER(handle) = ${lower} AND kind = 'archive_month'
  `;
  return Number(months[0]!.count) > 0;
}

export async function isLichessHandleReady(sql: postgres.Sql, handle: string): Promise<boolean> {
  const lower = handle.toLowerCase();
  // Lichess coverage comes from monthly dumps, not a per-handle queue.
  // A handle is ready iff we have at least one game for them in the
  // corpus — that means the most-recent dump scan picked them up.
  const rows = await sql<{ has_games: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM games
      WHERE source = 'lichess'
        AND (LOWER(white_handle_snapshot) = ${lower}
          OR LOWER(black_handle_snapshot) = ${lower})
      LIMIT 1
    ) AS has_games
  `;
  return rows[0]?.has_games === true;
}

/**
 * If the handle is now scout-ready, upsert into handles and stamp
 * scout_ready_at = NOW(). Idempotent — safe to call repeatedly.
 *
 * Returns true if marked (or refreshed); false if not ready.
 */
export async function markIfScoutReady(
  sql: postgres.Sql,
  platform: Platform,
  handle: string,
): Promise<boolean> {
  const ready =
    platform === 'chess.com'
      ? await isChesscomHandleReady(sql, handle)
      : await isLichessHandleReady(sql, handle);
  if (!ready) return false;

  const lower = handle.toLowerCase();
  // Compute game-window stats from the games table. This is a sequential
  // scan over the handle's games (indexed via white/black player_id idx
  // post-stage2, but for now we filter by handle snapshot which is fast
  // enough at our scale).
  const stats = await sql<
    { games_seen: string; first_seen: string | null; last_seen: string | null }[]
  >`
    SELECT
      COUNT(*)::text AS games_seen,
      MIN(played_at)::text AS first_seen,
      MAX(played_at)::text AS last_seen
    FROM games
    WHERE source = ${platform}
      AND (LOWER(white_handle_snapshot) = ${lower}
        OR LOWER(black_handle_snapshot) = ${lower})
  `;
  const s = stats[0]!;
  const gamesSeen = Number(s.games_seen);

  await sql`
    INSERT INTO handles (platform, handle, games_seen, first_seen_at, last_seen_at, scout_ready_at)
    VALUES (
      ${platform},
      ${lower},
      ${gamesSeen},
      ${s.first_seen ?? new Date().toISOString()},
      ${s.last_seen ?? new Date().toISOString()},
      NOW()
    )
    ON CONFLICT (platform, handle) DO UPDATE SET
      games_seen = EXCLUDED.games_seen,
      last_seen_at = COALESCE(EXCLUDED.last_seen_at, handles.last_seen_at),
      scout_ready_at = NOW()
  `;
  return true;
}

/**
 * Worker-safe wrapper around markIfScoutReady. Swallows errors with a
 * warn so a database hiccup never aborts the crawl loop.
 */
export async function safeMarkIfScoutReady(
  sql: postgres.Sql,
  platform: Platform,
  handle: string,
): Promise<void> {
  try {
    await markIfScoutReady(sql, platform, handle);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[scout-ready] mark failed for ${platform}/${handle}: ${msg}`);
  }
}

/**
 * One-shot backfill: SQL-aggregate over both queue tables, identify
 * scout-ready handles, compute their game-window stats from `games`,
 * and bulk-upsert into `handles`. Safe to re-run (idempotent upserts).
 *
 * Done as two CTEs (one per platform) instead of the row-by-row Node
 * loop you'd be tempted to write — this is ~20x faster on the current
 * corpus (~491k queue handles).
 */
export async function backfillAll(
  sql: postgres.Sql,
): Promise<{ chesscom_ready: number; lichess_ready: number }> {
  // chess.com — handle is ready iff every queue row is done AND ≥1 archive_month exists
  const chessResult = await sql<{ handle: string }[]>`
    WITH ready AS (
      SELECT LOWER(handle) AS handle
      FROM chesscom_crawl_queue
      GROUP BY LOWER(handle)
      HAVING COUNT(*) FILTER (WHERE status != 'done') = 0
         AND COUNT(*) FILTER (WHERE kind = 'archive_month') > 0
    ),
    sides AS (
      SELECT LOWER(white_handle_snapshot) AS handle, played_at
        FROM games WHERE source = 'chess.com' AND white_handle_snapshot IS NOT NULL
      UNION ALL
      SELECT LOWER(black_handle_snapshot), played_at
        FROM games WHERE source = 'chess.com' AND black_handle_snapshot IS NOT NULL
    ),
    stats AS (
      SELECT s.handle,
             COUNT(*) AS games_seen,
             COALESCE(MIN(s.played_at), NOW()) AS first_seen,
             COALESCE(MAX(s.played_at), NOW()) AS last_seen
      FROM sides s
      INNER JOIN ready r ON r.handle = s.handle
      GROUP BY s.handle
    )
    INSERT INTO handles (platform, handle, games_seen, first_seen_at, last_seen_at, scout_ready_at)
    SELECT 'chess.com', r.handle,
           COALESCE(s.games_seen, 0),
           COALESCE(s.first_seen, NOW()),
           COALESCE(s.last_seen, NOW()),
           NOW()
    FROM ready r
    LEFT JOIN stats s ON s.handle = r.handle
    ON CONFLICT (platform, handle) DO UPDATE SET
      games_seen = EXCLUDED.games_seen,
      last_seen_at = EXCLUDED.last_seen_at,
      scout_ready_at = NOW()
    RETURNING handle
  `;

  // lichess — handle is ready iff it has ≥1 game in the corpus (which
  // comes from monthly dumps, not a per-handle queue).
  const liResult = await sql<{ handle: string }[]>`
    WITH sides AS (
      SELECT LOWER(white_handle_snapshot) AS handle, played_at
        FROM games WHERE source = 'lichess' AND white_handle_snapshot IS NOT NULL
      UNION ALL
      SELECT LOWER(black_handle_snapshot), played_at
        FROM games WHERE source = 'lichess' AND black_handle_snapshot IS NOT NULL
    ),
    stats AS (
      SELECT handle,
             COUNT(*) AS games_seen,
             COALESCE(MIN(played_at), NOW()) AS first_seen,
             COALESCE(MAX(played_at), NOW()) AS last_seen
      FROM sides
      GROUP BY handle
    )
    INSERT INTO handles (platform, handle, games_seen, first_seen_at, last_seen_at, scout_ready_at)
    SELECT 'lichess', handle,
           games_seen,
           first_seen,
           last_seen,
           NOW()
    FROM stats
    ON CONFLICT (platform, handle) DO UPDATE SET
      games_seen = EXCLUDED.games_seen,
      last_seen_at = EXCLUDED.last_seen_at,
      scout_ready_at = NOW()
    RETURNING handle
  `;

  return { chesscom_ready: chessResult.length, lichess_ready: liResult.length };
}

async function main(): Promise<void> {
  const { client } = getGamesDb();
  try {
    const t0 = Date.now();
    console.log('[scout-ready] backfill starting…');
    const result = await backfillAll(client);
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `[scout-ready] done in ${dur}s — ` +
        `chess.com: ${result.chesscom_ready} ready; ` +
        `lichess: ${result.lichess_ready} ready`,
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

// Only run when invoked directly, not when imported.
const isCli = import.meta.url.endsWith('scout-ready.ts');
if (isCli) {
  main().catch((err) => {
    console.error('[scout-ready] failed:', err);
    process.exit(1);
  });
}
