-- ============================================================================
-- chessco-games corpus — initial schema (Cloud SQL Postgres 17)
-- ============================================================================
-- This DB is SEPARATE from Supabase. Cross-DB FKs are impossible, so any
-- column logically referring to a Supabase players.id is a plain uuid
-- (integrity enforced by workers, not the database).
--
-- Tables match the empty copies that landed on Supabase in migration 0001;
-- those empty copies will be dropped in Supabase migration 0007.
-- ============================================================================

-- Extensions are already enabled by SETUP-CLOUDSQL.md step 2:
--   pgcrypto, pg_stat_statements

-- ---------------------------------------------------------------------------
-- positions — FEN intern table (shared across all games)
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- games — partitioned by played_at month (RANGE)
--
-- played_at is NOT NULL (partition key requirement). For PGN imports without
-- a date header, workers fall back to imported_at or a sentinel before insert.
-- ---------------------------------------------------------------------------
CREATE TABLE games (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('lichess', 'chess.com', 'upload', 'fide', 'pgn_import', 'twic')),
  source_game_id text NOT NULL,
  white_player_id uuid,
  black_player_id uuid,
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
  played_at timestamptz NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT NOW(),
  raw_meta jsonb,
  PRIMARY KEY (id, played_at),
  UNIQUE (source, source_game_id, played_at)
) PARTITION BY RANGE (played_at);

CREATE INDEX games_played_at_idx ON games (played_at DESC);
CREATE INDEX games_white_player_id_idx ON games (white_player_id) WHERE white_player_id IS NOT NULL;
CREATE INDEX games_black_player_id_idx ON games (black_player_id) WHERE black_player_id IS NOT NULL;

-- Pre-create monthly partitions 2015-01 → 2030-12 (192 partitions).
-- Workers can create future partitions on demand via a helper later.
DO $$
DECLARE
  d date := DATE '2015-01-01';
  end_date date := DATE '2031-01-01';
  next_d date;
  pname text;
BEGIN
  WHILE d < end_date LOOP
    next_d := d + INTERVAL '1 month';
    pname := 'games_' || to_char(d, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF games FOR VALUES FROM (%L) TO (%L)',
      pname, d, next_d
    );
    d := next_d;
  END LOOP;
END $$;

-- Catch-all for any out-of-range rows (e.g. pre-2015 PGN imports).
CREATE TABLE games_default PARTITION OF games DEFAULT;

-- ---------------------------------------------------------------------------
-- moves — one row per ply. game_id is plain uuid (no FK to partitioned games).
-- ---------------------------------------------------------------------------
CREATE TABLE moves (
  id bigserial PRIMARY KEY,
  game_id uuid NOT NULL,
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

-- ---------------------------------------------------------------------------
-- Per-player aggregates
-- ---------------------------------------------------------------------------
CREATE TABLE player_position_stats (
  id bigserial PRIMARY KEY,
  player_id uuid NOT NULL,
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
  player_id uuid NOT NULL,
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

-- ---------------------------------------------------------------------------
-- style_features — Stage 3 stylometric vectors (engineered features Phase 1;
-- transformer embedding column added in a later migration when Phase 2 ships).
--
-- player_id here is the lichess/chess.com handle's identity within the games
-- corpus — a uuid generated when we first see the handle. May or may not link
-- to a Supabase players.id; the link lives in the Supabase external_accounts
-- table (out-of-band).
-- ---------------------------------------------------------------------------
CREATE TABLE style_features (
  player_id uuid PRIMARY KEY,
  features jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT NOW(),
  games_window integer NOT NULL
);

-- ---------------------------------------------------------------------------
-- migration ledger — track applied games-corpus migrations.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS games_corpus_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT NOW()
);

INSERT INTO games_corpus_migrations (id) VALUES ('0001_initial');
