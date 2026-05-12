-- ============================================================================
-- platform_players — pre-pulled handle directory for chess.com + Lichess
-- ============================================================================
-- Mirrors federation_players for online platforms. Populated by Phase 1 W2
-- workers (chesscom-titled, chesscom-country, lichess-titled) and the
-- lazy on-demand profile fetcher. Used by Scout Stage 2 (handle candidate
-- generation from name + country anchor).
--
-- NOT to be confused with games-corpus DB's `handles` table — that one
-- assigns stable uuids inside the games corpus. This table is the
-- searchable directory on the Supabase side.
-- ============================================================================

CREATE TABLE platform_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform text NOT NULL CHECK (platform IN ('lichess', 'chess.com')),
  handle text NOT NULL,
  handle_normalized text NOT NULL,    -- lower-cased + nfkc, used by fuzzy match
  player_id uuid REFERENCES players(id) ON DELETE SET NULL,
  country text,                       -- ISO 3166-1 alpha-2
  title text,                         -- GM, IM, FM, WGM, ...
  rating_bullet integer,
  rating_blitz integer,
  rating_rapid integer,
  rating_classical integer,
  is_verified_oauth boolean NOT NULL DEFAULT false,
  pulled_via text NOT NULL CHECK (pulled_via IN ('titled', 'country', 'lazy', 'self_oauth', 'inferred')),
  first_seen_at timestamptz NOT NULL DEFAULT NOW(),
  last_seen_at timestamptz NOT NULL DEFAULT NOW(),
  raw jsonb,
  UNIQUE (platform, handle)
);

CREATE INDEX platform_players_handle_trgm_idx
  ON platform_players USING gin (handle_normalized gin_trgm_ops);
CREATE INDEX platform_players_country_idx
  ON platform_players (country) WHERE country IS NOT NULL;
CREATE INDEX platform_players_player_id_idx
  ON platform_players (player_id) WHERE player_id IS NOT NULL;
CREATE INDEX platform_players_title_idx
  ON platform_players (title) WHERE title IS NOT NULL;

-- ============================================================================
-- pre-pull tracking — one row per (worker, target) so we can see when each
-- list was last refreshed without grepping logs.
-- ============================================================================

CREATE TABLE platform_pull_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker text NOT NULL,                -- 'chesscom-titled', 'chesscom-country', 'lichess-titled'
  target text NOT NULL,                -- e.g. 'GM', 'IL', 'all'
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  fetched integer NOT NULL DEFAULT 0,
  upserted integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT NOW(),
  completed_at timestamptz,
  error text,
  UNIQUE (worker, target, started_at)
);
CREATE INDEX platform_pull_runs_worker_target_idx
  ON platform_pull_runs (worker, target, started_at DESC);
