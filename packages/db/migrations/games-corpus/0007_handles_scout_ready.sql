-- ============================================================================
-- chessco-games corpus — mark handles as "scout-ready"
-- ============================================================================
-- Phase 1 of the scout-ready → persisted-repertoires → LLM-primary-matcher
-- plan (2026-05-14). A handle is scout-ready iff its full crawl window is
-- complete (every queue row status='done', no permanent gaps). Becoming
-- scout-ready unblocks: persistence in player_repertoires, inclusion in
-- the Stage 3 PGN matcher, and LLM-primary ranking.
--
-- Stored on the handles table because handles is the canonical entity
-- record. The scout-ready evaluator (apps/workers/src/identification/
-- scout-ready.ts) UPSERTS into handles when it confirms readiness, so
-- handles will grow naturally to cover every fully-crawled account
-- (including transitively-discovered ones from opponent discovery).
-- ============================================================================

ALTER TABLE handles
  ADD COLUMN IF NOT EXISTS scout_ready_at timestamptz;

-- Partial index: callers always filter on scout_ready_at IS NOT NULL,
-- and usually scope by platform.
CREATE INDEX IF NOT EXISTS handles_scout_ready_idx
  ON handles (platform, scout_ready_at)
  WHERE scout_ready_at IS NOT NULL;

INSERT INTO games_corpus_migrations (id) VALUES ('0007_handles_scout_ready');
