-- ============================================================================
-- chessco-games corpus — chess.com crawl queue + run tracking
-- ============================================================================
-- Phase 2 W1 pulled forward to W6: priority-queue crawler for chess.com.
-- Two row kinds per handle:
--   kind='archives_list'  → fetch /pub/player/{u}/games/archives, expand to
--                           one kind='archive_month' row per returned URL.
--   kind='archive_month'  → fetch the monthly PGN bundle, parse, ingest games.
--
-- One claim path is shared by both kinds; the worker dispatches on kind.
-- Resumability: every claim sets in_progress + claimed_at. Stale claims
-- (>10 min) are reset to error_retry on worker start.
-- ============================================================================

CREATE TABLE chesscom_crawl_queue (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('archives_list', 'archive_month')),
  handle text NOT NULL,
  -- Only set when kind='archive_month':
  archive_url text,
  archive_year int,
  archive_month int,
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
  last_error text,
  -- NULLS NOT DISTINCT (PG15+) collapses (handle, archives_list, NULL) duplicates.
  UNIQUE NULLS NOT DISTINCT (handle, kind, archive_url)
);

-- Hot path: workers ask "what should I run next?"
CREATE INDEX chesscom_crawl_queue_dequeue_idx
  ON chesscom_crawl_queue (next_attempt_at, priority DESC, id)
  WHERE status IN ('pending', 'error_retry');

CREATE INDEX chesscom_crawl_queue_handle_idx
  ON chesscom_crawl_queue (handle);

CREATE INDEX chesscom_crawl_queue_status_idx
  ON chesscom_crawl_queue (status);

-- ---------------------------------------------------------------------------
-- chesscom_crawl_runs — one row per worker session.
-- Heartbeat every ~30s for liveness. items_processed / games_inserted are
-- session totals; lifetime totals are aggregable across rows.
-- ---------------------------------------------------------------------------
CREATE TABLE chesscom_crawl_runs (
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

CREATE INDEX chesscom_crawl_runs_status_idx
  ON chesscom_crawl_runs (status, last_heartbeat_at DESC);

INSERT INTO games_corpus_migrations (id) VALUES ('0003_chesscom_crawl_queue');
