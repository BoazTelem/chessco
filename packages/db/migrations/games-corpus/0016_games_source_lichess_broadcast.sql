-- ============================================================================
-- games-corpus migration 0016 — extend games.source CHECK with lichess_broadcast
-- ============================================================================
-- The broadcasts ingester (apps/workers/src/external-pgn/ingest-games.ts)
-- now persists Lichess-broadcast PGNs directly into the canonical `games`
-- table with source='lichess_broadcast'. The original games.source CHECK
-- (0001_initial.sql) permits lichess/chess.com/upload/fide/pgn_import/twic
-- but not lichess_broadcast — without this migration the ingester fails
-- on the first broadcast row with a CHECK violation.
--
-- Split out of 0015 because 0015 was already applied with only the
-- external_pgn_sources CHECK extension; per migrations/README the
-- already-applied file must not be edited.
-- ============================================================================

ALTER TABLE games
  DROP CONSTRAINT IF EXISTS games_source_check;

ALTER TABLE games
  ADD CONSTRAINT games_source_check
  CHECK (source IN (
    'lichess',
    'chess.com',
    'upload',
    'fide',
    'pgn_import',
    'twic',
    'lichess_broadcast'
  ));

INSERT INTO games_corpus_migrations (id) VALUES ('0016_games_source_lichess_broadcast');
