-- ============================================================================
-- Migration: 0001_core_schema
-- Phase 0 Week 2 — core identity, federations, players, games.
-- Spec §5 v1.1 — first half of the schema.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Extensions (idempotent — already installed in Phase 0 Week 1 bootstrap)
-- ----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

-- ----------------------------------------------------------------------------
-- Helper: updated_at trigger
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- IDENTITY & ACCOUNTS
-- ============================================================================

CREATE TABLE profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username text UNIQUE,
  display_name text,
  email text UNIQUE,
  avatar_url text,
  country text,
  city text,
  date_of_birth date,
  chess_title text,
  bio text,
  preferred_language text DEFAULT 'en',
  marketing_consent boolean DEFAULT false,
  is_verified boolean DEFAULT false,
  kyc_status text DEFAULT 'none' CHECK (kyc_status IN ('none', 'pending', 'approved', 'rejected')),
  stripe_account_id text,
  stripe_customer_id text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  last_seen_at timestamptz,
  deleted_at timestamptz
);
CREATE TRIGGER profiles_set_updated_at BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE external_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('lichess', 'chess.com', 'fide', 'chess-results')),
  external_id text NOT NULL,
  external_url text,
  verified boolean DEFAULT false,
  confidence_score numeric,
  rating_blitz integer,
  rating_rapid integer,
  rating_classical integer,
  rating_bullet integer,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (platform, external_id)
);
CREATE INDEX external_accounts_profile_id_idx ON external_accounts (profile_id);
CREATE INDEX external_accounts_handle_trgm_idx
  ON external_accounts USING gin (external_id gin_trgm_ops);

CREATE TABLE verification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  platform text NOT NULL,
  token text NOT NULL UNIQUE,
  consumed boolean DEFAULT false,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX verification_tokens_profile_id_idx ON verification_tokens (profile_id);

-- ============================================================================
-- FEDERATIONS & OFFICIAL RATING LISTS (spec §5 v1.1)
-- ============================================================================

CREATE TABLE federations (
  id text PRIMARY KEY,
  name text NOT NULL,
  country text,
  rating_list_url text,
  rating_list_format text CHECK (rating_list_format IN ('xml', 'csv', 'json', 'html')),
  sync_cadence text CHECK (sync_cadence IN ('monthly', 'quarterly', 'manual')),
  last_synced_at timestamptz,
  active boolean DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

-- Seed the FIDE federation row so the ingestion worker has its parent FK.
INSERT INTO federations (id, name, country, rating_list_url, rating_list_format, sync_cadence, active)
VALUES
  ('FIDE', 'International Chess Federation', NULL, 'https://ratings.fide.com/download.phtml', 'xml', 'monthly', true),
  ('USCF', 'United States Chess Federation', 'US', 'https://www.uschess.org/datapage/', 'html', 'monthly', false),
  ('ECF', 'English Chess Federation', 'GB', 'https://www.englishchess.org.uk/ecf-publications/', 'html', 'quarterly', false),
  ('DSB', 'Deutscher Schachbund', 'DE', 'https://www.schachbund.de/dwz.html', 'html', 'monthly', false),
  ('FSI', 'Federazione Scacchistica Italiana', 'IT', 'https://www.federscacchi.it/', 'html', 'monthly', false),
  ('FFE', 'Fédération Française des Échecs', 'FR', 'https://www.echecs.asso.fr/', 'html', 'monthly', false);

-- Forward declaration: players exists below but federation_players references it.
-- We'll add the FK after players is created.

CREATE TABLE federation_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  federation_id text NOT NULL REFERENCES federations(id) ON DELETE RESTRICT,
  federation_player_id text NOT NULL,
  name text NOT NULL,
  name_normalized text NOT NULL,
  country text,
  birth_year integer,
  gender char(1) CHECK (gender IN ('M', 'F')),
  title text,
  rating_standard integer,
  rating_rapid integer,
  rating_blitz integer,
  rating_quick integer,
  player_id uuid,                    -- FK to players.id added after players table exists
  last_updated_at timestamptz NOT NULL DEFAULT NOW(),
  removed_from_list_at timestamptz,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (federation_id, federation_player_id)
);
CREATE INDEX federation_players_name_trgm_idx
  ON federation_players USING gin (name_normalized gin_trgm_ops);
CREATE INDEX federation_players_country_rating_idx
  ON federation_players (country, rating_standard);
CREATE INDEX federation_players_player_id_idx
  ON federation_players (player_id) WHERE player_id IS NOT NULL;

CREATE TABLE federation_rating_snapshots (
  id bigserial PRIMARY KEY,
  federation_player_id uuid NOT NULL REFERENCES federation_players(id) ON DELETE CASCADE,
  snapshot_date date NOT NULL,
  rating_standard integer,
  rating_rapid integer,
  rating_blitz integer,
  title text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (federation_player_id, snapshot_date)
);
CREATE INDEX federation_rating_snapshots_player_date_idx
  ON federation_rating_snapshots (federation_player_id, snapshot_date DESC);

-- ============================================================================
-- PLAYERS (canonical "person" — may or may not be a registered profile)
-- ============================================================================

CREATE TABLE players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name text,
  profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  country text,
  fide_id text,
  peak_rating integer,
  embedding vector(384),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE TRIGGER players_set_updated_at BEFORE UPDATE ON players
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX players_profile_id_idx ON players (profile_id) WHERE profile_id IS NOT NULL;
CREATE INDEX players_fide_id_idx ON players (fide_id) WHERE fide_id IS NOT NULL;
-- HNSW vector index added in 0003_indexes_and_rls once embeddings are populated.

-- Now add the deferred FK from federation_players to players.
ALTER TABLE federation_players
  ADD CONSTRAINT federation_players_player_id_fkey
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE SET NULL;

CREATE TABLE player_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  platform text NOT NULL,
  handle text NOT NULL,
  confidence numeric CHECK (confidence >= 0 AND confidence <= 1),
  source text CHECK (source IN ('verified', 'manual', 'inferred')),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (platform, handle)
);
CREATE INDEX player_aliases_player_id_idx ON player_aliases (player_id);
CREATE INDEX player_aliases_handle_trgm_idx
  ON player_aliases USING gin (handle gin_trgm_ops);

-- ============================================================================
-- GAMES & POSITIONS
-- ============================================================================
-- Note: partitioning of `games` by played_at month is deferred to a separate
-- migration before Phase 1 bulk ingest (spec §5 partitioning note). Initial
-- table is non-partitioned; works fine until corpus grows past ~1M rows.

CREATE TABLE games (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('lichess', 'chess.com', 'upload', 'fide', 'pgn_import')),
  source_game_id text NOT NULL,
  white_player_id uuid REFERENCES players(id) ON DELETE SET NULL,
  black_player_id uuid REFERENCES players(id) ON DELETE SET NULL,
  white_handle_snapshot text,
  black_handle_snapshot text,
  white_rating integer,
  black_rating integer,
  pgn text NOT NULL,
  initial_fen text,
  result text CHECK (result IN ('1-0', '0-1', '1/2-1/2', '*')),
  termination text,
  time_control text,
  time_class text CHECK (time_class IN ('bullet', 'blitz', 'rapid', 'classical', 'correspondence')),
  opening_eco text,
  opening_name text,
  ply_count integer,
  played_at timestamptz,
  imported_at timestamptz NOT NULL DEFAULT NOW(),
  raw_meta jsonb,
  UNIQUE (source, source_game_id)
);
CREATE INDEX games_played_at_idx ON games (played_at DESC);
CREATE INDEX games_white_player_id_idx ON games (white_player_id) WHERE white_player_id IS NOT NULL;
CREATE INDEX games_black_player_id_idx ON games (black_player_id) WHERE black_player_id IS NOT NULL;

CREATE TABLE positions (
  id bigserial PRIMARY KEY,
  fen text NOT NULL UNIQUE,
  fen_hash bigint NOT NULL UNIQUE,
  side_to_move char(1) CHECK (side_to_move IN ('w', 'b')),
  ply integer,
  eco text,
  opening_name text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE moves (
  id bigserial PRIMARY KEY,
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply integer NOT NULL,
  san text NOT NULL,
  uci text NOT NULL,
  fen_before_id bigint NOT NULL REFERENCES positions(id),
  fen_after_id bigint NOT NULL REFERENCES positions(id),
  clock_white_ms integer,
  clock_black_ms integer,
  eval_before_cp integer,
  eval_after_cp integer,
  eval_before_mate integer,
  eval_after_mate integer,
  cp_loss integer,
  is_book_move boolean DEFAULT false,
  is_blunder boolean DEFAULT false,
  is_mistake boolean DEFAULT false,
  is_inaccuracy boolean DEFAULT false
);
CREATE INDEX moves_game_id_ply_idx ON moves (game_id, ply);
CREATE INDEX moves_fen_before_id_idx ON moves (fen_before_id);
CREATE INDEX moves_blunder_idx ON moves (fen_before_id) WHERE is_blunder = true;

-- ============================================================================
-- PER-PLAYER AGGREGATES (analytical backbone)
-- ============================================================================

CREATE TABLE player_position_stats (
  id bigserial PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position_id bigint NOT NULL REFERENCES positions(id),
  color char(1) NOT NULL CHECK (color IN ('w', 'b')),
  games_count integer NOT NULL DEFAULT 0,
  wins integer NOT NULL DEFAULT 0,
  draws integer NOT NULL DEFAULT 0,
  losses integer NOT NULL DEFAULT 0,
  avg_cp_loss_next_move numeric,
  blunder_rate numeric,
  last_seen_at timestamptz,
  UNIQUE (player_id, position_id, color)
);
CREATE INDEX player_position_stats_player_count_idx
  ON player_position_stats (player_id, color, games_count DESC);

CREATE TABLE player_opening_stats (
  id bigserial PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position_id bigint NOT NULL REFERENCES positions(id),
  color char(1) NOT NULL CHECK (color IN ('w', 'b')),
  next_move_uci text NOT NULL,
  next_move_san text NOT NULL,
  games_count integer NOT NULL DEFAULT 0,
  wins integer NOT NULL DEFAULT 0,
  draws integer NOT NULL DEFAULT 0,
  losses integer NOT NULL DEFAULT 0,
  avg_cp_loss numeric,
  UNIQUE (player_id, position_id, color, next_move_uci)
);

CREATE TABLE style_features (
  player_id uuid PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  features jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT NOW(),
  games_window integer NOT NULL
);

-- ============================================================================
-- IDENTIFICATION (queries + candidates persisted for audit & revisit)
-- ============================================================================

CREATE TABLE identification_queries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  query_payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  completed_at timestamptz
);
CREATE INDEX identification_queries_requested_by_idx
  ON identification_queries (requested_by, created_at DESC);

CREATE TABLE identification_candidates (
  id bigserial PRIMARY KEY,
  query_id uuid NOT NULL REFERENCES identification_queries(id) ON DELETE CASCADE,
  rank integer NOT NULL,
  federation_player_id uuid REFERENCES federation_players(id) ON DELETE SET NULL,
  player_id uuid REFERENCES players(id) ON DELETE SET NULL,
  confidence_label text CHECK (confidence_label IN ('high', 'medium', 'low')),
  combined_score numeric,
  anchor_score numeric,
  handle_score numeric,
  style_score numeric,
  evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX identification_candidates_query_rank_idx
  ON identification_candidates (query_id, rank);

-- ============================================================================
-- PREP REPORTS
-- ============================================================================

CREATE TABLE prep_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_player_id uuid REFERENCES players(id) ON DELETE SET NULL,
  target_player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'building', 'ready', 'failed')),
  summary text,
  recommended_white_lines jsonb,
  recommended_black_lines jsonb,
  avoid_lines jsonb,
  practice_positions jsonb,
  raw_findings jsonb,
  pdf_url text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  completed_at timestamptz,
  expires_at timestamptz
);
CREATE INDEX prep_reports_requested_by_idx ON prep_reports (requested_by, created_at DESC);
CREATE INDEX prep_reports_target_player_idx ON prep_reports (target_player_id);
