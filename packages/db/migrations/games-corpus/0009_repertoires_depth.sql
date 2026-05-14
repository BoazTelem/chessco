-- ============================================================================
-- chessco-games corpus — multi-depth repertoires
-- ============================================================================
-- Phase 2 enhancement: store both a shallow (depth 12) and deep (depth 30)
-- variant of each player's repertoire. Shallow trees feed the PGN matcher
-- (faster cosine on smaller node sets); deep trees feed /prepare for full
-- prep work.
--
-- The previous PK (player_id, color) becomes (player_id, color, depth).
-- Existing rows are deleted because they were built against the old schema
-- with an implicit depth — and only the one test handle (danielnaroditsky)
-- had been populated yet.
-- ============================================================================

DELETE FROM player_repertoires;

ALTER TABLE player_repertoires
  ADD COLUMN IF NOT EXISTS depth integer NOT NULL DEFAULT 12;

ALTER TABLE player_repertoires
  DROP CONSTRAINT IF EXISTS player_repertoires_pkey;

ALTER TABLE player_repertoires
  ADD PRIMARY KEY (player_id, color, depth);

INSERT INTO games_corpus_migrations (id) VALUES ('0009_repertoires_depth');
