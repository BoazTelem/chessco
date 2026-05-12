-- ============================================================================
-- chessco-games corpus — lichess dump run tracking + handle registry
-- ============================================================================
-- Phase 1 W1: Lichess monthly dump worker needs resumable state + a handle
-- registry so style_features and aggregates can be keyed by a stable uuid.
--
-- Prerequisite: pg_trgm extension must be enabled (see docs/SETUP-CLOUDSQL.md
-- step 2). chessco_worker lacks CREATE EXTENSION privilege.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- handles — one row per (platform, handle) pair we've seen in any game.
-- Stable uuid used by style_features.player_id and games.{white,black}_player_id.
-- Links to Supabase profiles (when the handle is OAuth-verified) live in
-- Supabase's external_accounts table — not joined across DBs.
-- ---------------------------------------------------------------------------
CREATE TABLE handles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform text NOT NULL CHECK (platform IN ('lichess', 'chess.com', 'fide', 'twic', 'upload')),
  handle text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT NOW(),
  last_seen_at timestamptz NOT NULL DEFAULT NOW(),
  games_seen integer NOT NULL DEFAULT 0,
  UNIQUE (platform, handle)
);
CREATE INDEX handles_handle_trgm_idx ON handles USING gin (handle gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- lichess_dump_runs — one row per monthly dump processed.
-- The worker writes here every few seconds with counters so progress
-- survives crashes; a re-run with the same dump_id picks up where it
-- left off using bytes_downloaded as the resume offset.
-- ---------------------------------------------------------------------------
CREATE TABLE lichess_dump_runs (
  dump_id text PRIMARY KEY,                 -- e.g. '2024-01'
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  source_url text NOT NULL,
  total_bytes bigint,                       -- Content-Length, when known
  bytes_downloaded bigint NOT NULL DEFAULT 0,
  games_seen bigint NOT NULL DEFAULT 0,
  games_filtered_in bigint NOT NULL DEFAULT 0,
  positions_inserted bigint NOT NULL DEFAULT 0,
  moves_inserted bigint NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  completed_at timestamptz,
  error text
);

INSERT INTO games_corpus_migrations (id) VALUES ('0002_lichess_dump_runs');
