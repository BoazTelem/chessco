-- ============================================================================
-- chessco-games corpus — per-game cp-loss aggregates (Phase 1 W5)
-- ============================================================================
-- New columns on `games` to store the output of Stockfish per-game analysis:
--   mean_cp_loss           — average centipawns lost per ply (all sides)
--   mean_cp_loss_white     — same, white's moves only
--   mean_cp_loss_black     — same, black's moves only
--   blunder_count          — plies where cp-loss >= 200
--   plies_analyzed         — number of plies the analyzer actually evaluated
--                            (after skipping book + endgame; depth defaulted to 10)
--   analyzed_at            — when the analysis ran. Used by the backfill worker
--                            as the "skip if already done" guard. Indexed so the
--                            queue can pick up unanalyzed games efficiently.
--
-- Adding columns to a partitioned table propagates to every child partition
-- in Postgres 17. The DEFAULT NULL keeps existing rows untouched (no rewrite).
-- ============================================================================

ALTER TABLE games
  ADD COLUMN IF NOT EXISTS mean_cp_loss        numeric,
  ADD COLUMN IF NOT EXISTS mean_cp_loss_white  numeric,
  ADD COLUMN IF NOT EXISTS mean_cp_loss_black  numeric,
  ADD COLUMN IF NOT EXISTS blunder_count       integer,
  ADD COLUMN IF NOT EXISTS plies_analyzed      integer,
  ADD COLUMN IF NOT EXISTS analyzed_at         timestamptz;

-- Find-next-unanalyzed-game index. Partial so the index size stays tiny once
-- most games are analyzed (the index only stores the un-done ones).
CREATE INDEX IF NOT EXISTS games_unanalyzed_idx
  ON games (played_at)
  WHERE analyzed_at IS NULL AND length(pgn) > 0;

INSERT INTO games_corpus_migrations (id) VALUES ('0004_game_cp_loss')
ON CONFLICT (id) DO NOTHING;
