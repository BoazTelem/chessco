-- ============================================================================
-- chessco-games corpus — add next_refresh_at to both crawl queues
-- ============================================================================
-- Pillar C of the comprehensive-seed-expansion plan (2026-05-13):
-- continuous re-crawl every 7 days. When the crawler marks an item done,
-- it sets next_refresh_at = NOW() + 7 days. A daily Inngest cron flips
-- rows back to status='pending' once next_refresh_at < NOW(), so workers
-- pick them up on the next iteration of their loop.
-- ============================================================================

ALTER TABLE chesscom_crawl_queue
  ADD COLUMN next_refresh_at timestamptz;

ALTER TABLE lichess_crawl_queue
  ADD COLUMN next_refresh_at timestamptz;

-- Partial index: only the cron's WHERE-clause matters here.
CREATE INDEX chesscom_crawl_queue_refresh_idx
  ON chesscom_crawl_queue (next_refresh_at)
  WHERE status = 'done' AND next_refresh_at IS NOT NULL;

CREATE INDEX lichess_crawl_queue_refresh_idx
  ON lichess_crawl_queue (next_refresh_at)
  WHERE status = 'done' AND next_refresh_at IS NOT NULL;

INSERT INTO games_corpus_migrations (id) VALUES ('0006_queue_refresh');
