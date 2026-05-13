/**
 * lichess_crawl_queue helpers — claim/complete/fail + run heartbeat.
 *
 * Simpler than chesscom-crawl/queue.ts: one row per handle, single
 * kind (the user-games-export request covers the whole window in one
 * call), no archives_list → archive_month expansion phase.
 */
import type postgres from 'postgres';

export interface LichessQueueRow {
  id: string;
  handle: string;
  status: 'pending' | 'in_progress' | 'done' | 'error_retry' | 'error_permanent';
  priority: number;
  attempts: number;
}

const MAX_ATTEMPTS = 5;
/** Backoff in seconds keyed by attempt count (1-indexed). */
const RETRY_BACKOFF_SEC = [60, 300, 1800, 14400, 86400];

/**
 * Reset orphaned in_progress claims from crashed workers. > 10 min old
 * are considered abandoned (legitimate item processing is sub-minute).
 */
export async function recoverStaleClaims(sql: postgres.Sql): Promise<number> {
  const result = await sql<{ id: string }[]>`
    UPDATE lichess_crawl_queue
    SET status = 'error_retry',
        next_attempt_at = NOW(),
        last_error = COALESCE(last_error, '') || ' [recovered from stale claim]'
    WHERE status = 'in_progress'
      AND claimed_at < NOW() - INTERVAL '10 minutes'
    RETURNING id
  `;
  return result.length;
}

export async function claimNext(sql: postgres.Sql, limit: number): Promise<LichessQueueRow[]> {
  return sql<LichessQueueRow[]>`
    UPDATE lichess_crawl_queue q
    SET status = 'in_progress',
        claimed_at = NOW(),
        attempts = q.attempts + 1
    FROM (
      SELECT id FROM lichess_crawl_queue
      WHERE status IN ('pending', 'error_retry')
        AND next_attempt_at <= NOW()
      ORDER BY priority DESC, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    ) AS picked
    WHERE q.id = picked.id
    RETURNING q.id, q.handle, q.status, q.priority, q.attempts
  `;
}

export async function completeItem(
  sql: postgres.Sql,
  id: string,
  gamesInserted: number,
): Promise<void> {
  await sql`
    UPDATE lichess_crawl_queue
    SET status = 'done',
        completed_at = NOW(),
        games_inserted = ${gamesInserted},
        last_error = NULL
    WHERE id = ${id}
  `;
}

export async function failItem(
  sql: postgres.Sql,
  id: string,
  attempts: number,
  error: string,
): Promise<'retry' | 'permanent'> {
  const truncatedError = error.length > 2000 ? error.slice(0, 2000) + '…' : error;
  if (attempts >= MAX_ATTEMPTS) {
    await sql`
      UPDATE lichess_crawl_queue
      SET status = 'error_permanent',
          completed_at = NOW(),
          last_error = ${truncatedError}
      WHERE id = ${id}
    `;
    return 'permanent';
  }
  const backoffSec =
    RETRY_BACKOFF_SEC[Math.min(attempts - 1, RETRY_BACKOFF_SEC.length - 1)] ?? 86400;
  await sql`
    UPDATE lichess_crawl_queue
    SET status = 'error_retry',
        next_attempt_at = NOW() + (${backoffSec} || ' seconds')::interval,
        last_error = ${truncatedError}
    WHERE id = ${id}
  `;
  return 'retry';
}

// ---------------------------------------------------------------------------
// lichess_crawl_runs — session-level heartbeat / counters
// ---------------------------------------------------------------------------

export async function startRun(sql: postgres.Sql, workerId: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO lichess_crawl_runs (worker_id) VALUES (${workerId})
    RETURNING id
  `;
  return rows[0]!.id;
}

export async function tickRun(
  sql: postgres.Sql,
  runId: string,
  delta: { items: number; games: number; errors: number },
): Promise<void> {
  await sql`
    UPDATE lichess_crawl_runs
    SET items_processed = items_processed + ${delta.items},
        games_inserted = games_inserted + ${delta.games},
        errors = errors + ${delta.errors},
        last_heartbeat_at = NOW()
    WHERE id = ${runId}
  `;
}

export async function finishRun(
  sql: postgres.Sql,
  runId: string,
  status: 'done' | 'stopped' | 'failed',
  error?: string,
): Promise<void> {
  await sql`
    UPDATE lichess_crawl_runs
    SET status = ${status},
        ended_at = NOW(),
        last_error = ${error ?? null}
    WHERE id = ${runId}
  `;
}

// ---------------------------------------------------------------------------
// Reporting + seeding
// ---------------------------------------------------------------------------

export interface QueueProgress {
  pending: number;
  in_progress: number;
  done: number;
  error_retry: number;
  error_permanent: number;
}

export async function queueProgress(sql: postgres.Sql): Promise<QueueProgress> {
  const rows = await sql<{ status: string; count: string }[]>`
    SELECT status, COUNT(*)::text AS count
    FROM lichess_crawl_queue
    GROUP BY status
  `;
  const out: QueueProgress = {
    pending: 0,
    in_progress: 0,
    done: 0,
    error_retry: 0,
    error_permanent: 0,
  };
  for (const r of rows) {
    if (r.status in out) {
      (out as unknown as Record<string, number>)[r.status] = Number.parseInt(r.count, 10);
    }
  }
  return out;
}

/**
 * Insert one row per handle. Idempotent — re-runs are no-ops thanks to
 * the UNIQUE constraint on handle.
 */
export async function seedHandles(
  sql: postgres.Sql,
  handles: string[],
  priority = 0,
): Promise<number> {
  if (handles.length === 0) return 0;
  const CHUNK = 5000;
  const insert = sql as unknown as (rows: object[], ...cols: string[]) => postgres.Helper<object[]>;

  let inserted = 0;
  for (let i = 0; i < handles.length; i += CHUNK) {
    const rows = handles.slice(i, i + CHUNK).map((h) => ({
      handle: h.toLowerCase(),
      priority,
    }));
    const result = await sql<{ id: string }[]>`
      INSERT INTO lichess_crawl_queue
        ${insert(rows, 'handle', 'priority')}
      ON CONFLICT (handle) DO NOTHING
      RETURNING id
    `;
    inserted += result.length;
  }
  return inserted;
}
