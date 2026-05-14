-- ============================================================================
-- chessco-games corpus — index handle_snapshot lookups
-- ============================================================================
-- For chess.com games (and many lichess imports) the *_player_id FK columns
-- are NULL — handles are identified via *_handle_snapshot. Existing batch
-- jobs (repertoire builder, fingerprint extract) accept a full-table scan
-- because they run offline; the new on-demand Personalized Leaks flow
-- cannot — a GET request on /api/prepare/reports/[id] needs sub-second
-- handle lookups.
--
-- Adds two partial indexes (one per color) on (source, LOWER(handle), played_at)
-- so the typical "most-recent N games for handle H on platform P" query
-- becomes an index range scan + small heap fetch.
-- ============================================================================

CREATE INDEX IF NOT EXISTS games_white_handle_snap_idx
  ON games (source, LOWER(white_handle_snapshot), played_at DESC)
  WHERE white_handle_snapshot IS NOT NULL;

CREATE INDEX IF NOT EXISTS games_black_handle_snap_idx
  ON games (source, LOWER(black_handle_snapshot), played_at DESC)
  WHERE black_handle_snapshot IS NOT NULL;

INSERT INTO games_corpus_migrations (id) VALUES ('0012_games_handle_snapshot_idx');
