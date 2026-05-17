-- ============================================================================
-- games-corpus migration 0015 — extend external_pgn_sources source enum
-- ============================================================================
-- Adds 'lichess_broadcast' to the source CHECK constraint so the Lichess
-- broadcasts ingester (apps/workers/src/external-pgn/lichess-broadcasts/)
-- can stage rows into external_pgn_sources alongside TWIC, chessgames,
-- etc. The downstream resolver + games-table ingester then operate on
-- broadcast rows the same way they do TWIC rows — no special-casing.
--
-- Why broadcasts on top of TWIC:
--   - TWIC publishes a weekly zip of completed games (lag: days).
--   - Lichess broadcasts are LIVE: PGNs update as games are played, with
--     rich headers ([WhiteFideId], [WhiteLichess], etc.) directly
--     linking OTB FIDE players to their online accounts on Lichess.
--   - For elite events covered by both, broadcasts arrive first AND
--     carry stronger identity signal — a strict superset of what the
--     pure-PGN-shape TWIC ingest captures.
--
-- The cached PGN headers (white_name, black_name, …) and the resolver
-- fields (white_fide_id, black_fide_id) stay schema-identical — same
-- staging row shape, just a new source label.
-- ============================================================================

ALTER TABLE external_pgn_sources
  DROP CONSTRAINT IF EXISTS external_pgn_sources_source_check;

ALTER TABLE external_pgn_sources
  ADD CONSTRAINT external_pgn_sources_source_check
  CHECK (source IN (
    'twic',
    'chessgames',
    '365chess',
    'chesstempo',
    'chessbase',
    'megabase',
    'lichess_broadcast'
  ));

INSERT INTO games_corpus_migrations (id) VALUES ('0015_external_pgn_sources_lichess_broadcast');
