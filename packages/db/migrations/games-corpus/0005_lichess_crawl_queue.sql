-- ============================================================================
-- chessco-games corpus — Lichess per-handle crawl queue + run tracking
-- ============================================================================
-- Parallel to chesscom_crawl_queue. Different shape because Lichess's
-- /api/games/user/{u} endpoint returns the whole window in one streamed
-- response — no per-month split needed. One queue row per handle.
--
-- Workers stream PGN games out of the response, parse via the existing
-- lichess-dumps streamGames + processGame, and ingest via ingestBatch
-- (same path used by the dump worker). Resumability: stale in_progress
-- claims (> 10 min) are reset to error_retry on worker start.
-- ============================================================================

CREATE TABLE lichess_crawl_queue (
  id bigserial PRIMARY KEY,
  handle text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'in_progress', 'done', 'error_retry', 'error_permanent')
  ),
  priority int NOT NULL DEFAULT 0,
  attempts int NOT NULL DEFAULT 0,
  games_inserted int NOT NULL DEFAULT 0,
  enqueued_at timestamptz NOT NULL DEFAULT NOW(),
  claimed_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
  completed_at timestamptz,
  last_error text
);

CREATE INDEX lichess_crawl_queue_dequeue_idx
  ON lichess_crawl_queue (next_attempt_at, priority DESC, id)
  WHERE status IN ('pending', 'error_retry');

CREATE INDEX lichess_crawl_queue_status_idx
  ON lichess_crawl_queue (status);

-- ---------------------------------------------------------------------------
-- lichess_crawl_runs — one row per worker session. Same shape as
-- chesscom_crawl_runs.
-- ---------------------------------------------------------------------------
CREATE TABLE lichess_crawl_runs (
  id bigserial PRIMARY KEY,
  worker_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT NOW(),
  ended_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (
    status IN ('running', 'done', 'stopped', 'failed')
  ),
  items_processed int NOT NULL DEFAULT 0,
  games_inserted int NOT NULL DEFAULT 0,
  errors int NOT NULL DEFAULT 0,
  last_heartbeat_at timestamptz NOT NULL DEFAULT NOW(),
  last_error text
);

CREATE INDEX lichess_crawl_runs_status_idx
  ON lichess_crawl_runs (status, last_heartbeat_at DESC);

INSERT INTO games_corpus_migrations (id) VALUES ('0005_lichess_crawl_queue');
