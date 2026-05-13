/**
 * chesscom_crawl_queue helpers — claim/complete/fail/expand operations.
 *
 * The queue holds two kinds of rows:
 *   - kind='archives_list'  (one per handle, archive_url IS NULL)
 *   - kind='archive_month'  (one per monthly archive URL)
 *
 * Claim path is shared — the worker dispatches on kind after claiming.
 */
import type postgres from 'postgres';

export interface QueueRow {
  id: string;
  kind: 'archives_list' | 'archive_month';
  handle: string;
  archive_url: string | null;
  archive_year: number | null;
  archive_month: number | null;
  status: 'pending' | 'in_progress' | 'done' | 'error_retry' | 'error_permanent';
  priority: number;
  attempts: number;
}

const MAX_ATTEMPTS = 5;

/** Backoff in seconds keyed by attempt count (1-indexed). */
const RETRY_BACKOFF_SEC = [60, 300, 1800, 14400, 86400];

/**
 * Reset orphaned in_progress claims left behind by a crashed worker.
 * Anything claimed > 10 minutes ago is fair game — far longer than any
 * legitimate processing time for a single archive month.
 */
export async function recoverStaleClaims(sql: postgres.Sql): Promise<number> {
  const result = await sql<{ id: string }[]>`
    UPDATE chesscom_crawl_queue
    SET status = 'error_retry',
        next_attempt_at = NOW(),
        last_error = COALESCE(last_error, '') || ' [recovered from stale claim]'
    WHERE status = 'in_progress'
      AND claimed_at < NOW() - INTERVAL '10 minutes'
    RETURNING id
  `;
  return result.length;
}

/**
 * Atomically claim up to `limit` ready items (pending or error_retry with
 * next_attempt_at in the past). Higher priority first, then FIFO by id.
 * SKIP LOCKED makes concurrent workers safe but we run a single worker
 * by default.
 */
export async function claimNext(sql: postgres.Sql, limit: number): Promise<QueueRow[]> {
  return sql<QueueRow[]>`
    UPDATE chesscom_crawl_queue q
    SET status = 'in_progress',
        claimed_at = NOW(),
        attempts = q.attempts + 1
    FROM (
      SELECT id FROM chesscom_crawl_queue
      WHERE status IN ('pending', 'error_retry')
        AND next_attempt_at <= NOW()
      ORDER BY priority DESC, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    ) AS picked
    WHERE q.id = picked.id
    RETURNING q.id, q.kind, q.handle, q.archive_url, q.archive_year, q.archive_month,
              q.status, q.priority, q.attempts
  `;
}

export async function completeItem(
  sql: postgres.Sql,
  id: string,
  gamesInserted: number,
): Promise<void> {
  await sql`
    UPDATE chesscom_crawl_queue
    SET status = 'done',
        completed_at = NOW(),
        games_inserted = ${gamesInserted},
        last_error = NULL
    WHERE id = ${id}
  `;
}

/**
 * Schedule a retry with exponential backoff, or mark error_permanent once
 * attempts has reached MAX_ATTEMPTS.
 */
export async function failItem(
  sql: postgres.Sql,
  id: string,
  attempts: number,
  error: string,
): Promise<'retry' | 'permanent'> {
  const truncatedError = error.length > 2000 ? error.slice(0, 2000) + '…' : error;
  if (attempts >= MAX_ATTEMPTS) {
    await sql`
      UPDATE chesscom_crawl_queue
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
    UPDATE chesscom_crawl_queue
    SET status = 'error_retry',
        next_attempt_at = NOW() + (${backoffSec} || ' seconds')::interval,
        last_error = ${truncatedError}
    WHERE id = ${id}
  `;
  return 'retry';
}

/**
 * After a successful /games/archives fetch, replace the parent
 * archives_list row with one archive_month row per URL returned.
 * The parent row is marked done in the same transaction.
 *
 * archive_month rows always go in at priority=ARCHIVE_MONTH_PRIORITY
 * (above the archives_list default of 0) so workers drain them
 * preferentially over the backlog of unexpanded archives_lists. This
 * keeps games flowing continuously instead of waiting for the queue
 * expansion phase to complete.
 *
 * `monthsBack` limits how far back we enqueue per handle (e.g. 12 = the
 * most recent 12 months). null means all months returned.
 */
const ARCHIVE_MONTH_PRIORITY = 10;

export async function expandArchivesList(
  sql: postgres.Sql,
  parentId: string,
  handle: string,
  archiveUrls: string[],
  _priority: number,
  monthsBack: number | null,
): Promise<number> {
  // Sort by year/month descending so monthsBack truncates the oldest.
  const parsed = archiveUrls
    .map((url) => {
      const m = /\/games\/(\d{4})\/(\d{2})$/.exec(url);
      if (!m) return null;
      return { url, year: Number.parseInt(m[1]!, 10), month: Number.parseInt(m[2]!, 10) };
    })
    .filter((x): x is { url: string; year: number; month: number } => x !== null)
    .sort((a, b) => b.year * 12 + b.month - (a.year * 12 + a.month));

  const truncated = monthsBack !== null ? parsed.slice(0, monthsBack) : parsed;

  if (truncated.length === 0) {
    // Mark the parent done — no archives to fetch (player never played any
    // rated standard games per chess.com, or has a brand-new account).
    await sql`
      UPDATE chesscom_crawl_queue
      SET status = 'done', completed_at = NOW(), games_inserted = 0
      WHERE id = ${parentId}
    `;
    return 0;
  }

  return sql.begin(async (tx) => {
    // postgres-js v3.4 row-helper types reject readonly column tuples; cast.
    const insert = tx as unknown as (
      rows: object[],
      ...cols: string[]
    ) => postgres.Helper<object[]>;

    const rows = truncated.map((m) => ({
      kind: 'archive_month',
      handle,
      archive_url: m.url,
      archive_year: m.year,
      archive_month: m.month,
      priority: ARCHIVE_MONTH_PRIORITY,
    }));
    const inserted = await tx<{ id: string }[]>`
      INSERT INTO chesscom_crawl_queue
        ${insert(rows, 'kind', 'handle', 'archive_url', 'archive_year', 'archive_month', 'priority')}
      ON CONFLICT (handle, kind, archive_url) DO NOTHING
      RETURNING id
    `;
    await tx`
      UPDATE chesscom_crawl_queue
      SET status = 'done', completed_at = NOW(), games_inserted = 0
      WHERE id = ${parentId}
    `;
    return inserted.length;
  });
}

// ---------------------------------------------------------------------------
// chesscom_crawl_runs — session-level heartbeat / counters
// ---------------------------------------------------------------------------

export async function startRun(sql: postgres.Sql, workerId: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO chesscom_crawl_runs (worker_id) VALUES (${workerId})
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
    UPDATE chesscom_crawl_runs
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
    UPDATE chesscom_crawl_runs
    SET status = ${status},
        ended_at = NOW(),
        last_error = ${error ?? null}
    WHERE id = ${runId}
  `;
}

// ---------------------------------------------------------------------------
// Reporting / progress
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
    FROM chesscom_crawl_queue
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

// ---------------------------------------------------------------------------
// Seed-the-queue helpers
// ---------------------------------------------------------------------------

/**
 * Insert one archives_list row per handle. Idempotent — re-running with
 * the same handles is a no-op.
 */
export async function seedHandles(
  sql: postgres.Sql,
  handles: string[],
  priority = 0,
): Promise<number> {
  if (handles.length === 0) return 0;
  // Insert in chunks to stay well under Postgres' 65k-bound-params limit.
  // 5000 rows × 3 cols = 15k params — comfortable.
  const CHUNK = 5000;
  const insert = sql as unknown as (rows: object[], ...cols: string[]) => postgres.Helper<object[]>;

  let inserted = 0;
  for (let i = 0; i < handles.length; i += CHUNK) {
    const rows = handles.slice(i, i + CHUNK).map((h) => ({
      kind: 'archives_list',
      handle: h,
      priority,
    }));
    const result = await sql<{ id: string }[]>`
      INSERT INTO chesscom_crawl_queue
        ${insert(rows, 'kind', 'handle', 'priority')}
      ON CONFLICT (handle, kind, archive_url) DO NOTHING
      RETURNING id
    `;
    inserted += result.length;
  }
  return inserted;
}
