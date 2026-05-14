-- ============================================================================
-- chessco-games corpus — persisted per-account opening repertoires
-- ============================================================================
-- Phase 2 of the scout-ready → persisted-repertoires → LLM-primary-matcher
-- plan. One row per (player, color) holding the player's opening tree as
-- a JSONB blob. Built by apps/workers/src/repertoires/build.ts after a
-- handle becomes scout-ready (Phase 1).
--
-- Tree shape mirrors the client-side TreeNode from
-- apps/web/lib/prepare/tree-builder.ts so the existing /prepare UI can
-- consume it 1:1 once Phase 3 wires DB-first loading.
--
-- The aggregation tables player_position_stats / player_opening_stats
-- exist (from migration 0001) but are currently empty — we read directly
-- from the games + moves + positions tables instead. If those aggregations
-- ever get populated, the build worker can switch to read from them
-- without changing the storage shape here.
-- ============================================================================

CREATE TABLE IF NOT EXISTS player_repertoires (
  player_id    uuid NOT NULL REFERENCES handles(id) ON DELETE CASCADE,
  color        text NOT NULL CHECK (color IN ('white', 'black')),
  tree         jsonb NOT NULL,
  games_window integer NOT NULL,
  built_at     timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (player_id, color)
);

-- For Phase 6 (re-build on refresh): find oldest repertoires first.
CREATE INDEX IF NOT EXISTS player_repertoires_built_at_idx
  ON player_repertoires (built_at);

INSERT INTO games_corpus_migrations (id) VALUES ('0008_player_repertoire_cache');
