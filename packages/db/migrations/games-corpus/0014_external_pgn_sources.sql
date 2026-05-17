-- ============================================================================
-- chessco-games corpus — external PGN source staging table
-- ============================================================================
-- External public databases (TWIC, chessgames.com, ChessBase Megabase, …)
-- publish PGNs of FIDE-rated tournament players who may NOT have online
-- accounts on chess.com or Lichess. Auto-loading these games closes the
-- "found the player but they're anonymous online" case in the two-path
-- account finder (Feature 1 + Feature 2 in docs/external-pgn-auto-fetch.md).
--
-- Architecture: this table is a STAGING table. Workers ingest PGNs here
-- with cached header fields (white/black/Elo/date) and the raw PGN bytes
-- for audit + later parsing. Two downstream passes then run:
--
--   1. FIDE resolver — fills white_fide_id / black_fide_id by matching
--      white_name / black_name against Supabase federation_players via
--      pg_trgm. Sets fide_resolved_at.
--   2. Games ingester — for rows where ≥1 side resolved to FIDE, parses
--      the raw_pgn and inserts into the canonical games/moves/positions
--      tables. Sets game_id + game_ingested_at.
--
-- Both passes can run independently and re-run safely (gate on the
-- respective *_at column being NULL).
--
-- Why a staging table instead of writing straight into games:
--   - Cheap to backfill: a TWIC issue is ~10k games, but only ~1-5k may
--     resolve to FIDE players we care about. Staging avoids paying the
--     full games/moves/positions parse cost for the other 5-9k.
--   - Attribution-safe: raw_pgn lives next to the source URL so we can
--     prove provenance and respect the source's ToS (TWIC asks for
--     attribution; chessgames.com same).
--   - FK to games(id) is impossible because games is partitioned by
--     played_at (PK is composite). We track game_id as plain uuid and
--     enforce integrity in workers.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE external_pgn_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source          text NOT NULL CHECK (
    source IN ('twic', 'chessgames', '365chess', 'chesstempo', 'chessbase', 'megabase')
  ),
  -- Canonical URL or synthetic URI uniquely identifying the game within the
  -- source. For per-game sources (chessgames.com) this is the HTTPS deep
  -- link. For batch sources (TWIC) we synthesise twic://{issue}/{ordinal}
  -- and the display layer maps it to the issue's public HTML page.
  source_url      text NOT NULL,
  -- "World Rapid 2023", "FIDE Candidates 2024", …
  source_event    text,
  -- For batch sources: "twic1521", "megabase_2024". NULL for per-game.
  source_issue    text,
  fetched_at      timestamptz NOT NULL DEFAULT NOW(),
  -- The raw PGN block as we received it (or re-serialised from headers +
  -- move text when the source-specific parser doesn't preserve raw bytes).
  raw_pgn         text NOT NULL,

  -- Cached PGN header fields so the FIDE resolver doesn't have to re-parse
  -- each row's raw_pgn.
  white_name      text,
  black_name      text,
  white_elo       integer,
  black_elo       integer,
  played_at       timestamptz,
  result          text CHECK (result IN ('1-0', '0-1', '1/2-1/2', '*')),

  -- FIDE resolution (downstream pass 1).
  white_fide_id   uuid,
  black_fide_id   uuid,
  fide_resolved_at timestamptz,

  -- Games-table ingestion (downstream pass 2).
  game_id           uuid,
  game_ingested_at  timestamptz,

  UNIQUE (source, source_url)
);

-- Hot paths:
--   1. Resolver picks rows with no fide_resolved_at yet, per source.
--   2. Ingester picks rows with a FIDE link but no game_id yet.
--   3. Coverage dashboards count distinct fide IDs we have games for.
CREATE INDEX external_pgn_sources_unresolved_idx
  ON external_pgn_sources (source, source_issue)
  WHERE fide_resolved_at IS NULL;

CREATE INDEX external_pgn_sources_unparsed_idx
  ON external_pgn_sources (source, source_issue)
  WHERE game_id IS NULL
    AND (white_fide_id IS NOT NULL OR black_fide_id IS NOT NULL);

CREATE INDEX external_pgn_sources_white_fide_idx
  ON external_pgn_sources (white_fide_id) WHERE white_fide_id IS NOT NULL;
CREATE INDEX external_pgn_sources_black_fide_idx
  ON external_pgn_sources (black_fide_id) WHERE black_fide_id IS NOT NULL;

-- Trigram indexes so the FIDE resolver can do `name_normalized % white_name`
-- without sequential scans across hundreds of thousands of rows.
CREATE INDEX external_pgn_sources_white_name_trgm_idx
  ON external_pgn_sources USING gin (white_name gin_trgm_ops);
CREATE INDEX external_pgn_sources_black_name_trgm_idx
  ON external_pgn_sources USING gin (black_name gin_trgm_ops);

INSERT INTO games_corpus_migrations (id) VALUES ('0014_external_pgn_sources');
