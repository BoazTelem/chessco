-- ============================================================================
-- Migration: 0021_index_stats_rpc_v2
-- ============================================================================
-- Extends public_index_stats() to surface live crawl progress: distinct
-- chess.com + Lichess handles indexed in the games-corpus, sourced from
-- the hourly snapshot in corpus_index_counts (migration 0020).
--
-- Backward compatible — existing fields (fide/icf/uscf/federation_total/
-- platform_total/total) remain unchanged. Two new fields added:
--   - chesscomHandles: latest distinct chess.com handles from corpus
--   - lichessHandles:  latest distinct Lichess handles from corpus
-- ============================================================================

CREATE OR REPLACE FUNCTION public_index_stats()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'fide',     (SELECT COUNT(*) FROM federation_players WHERE federation_id = 'FIDE'),
    'icf',      (SELECT COUNT(*) FROM federation_players WHERE federation_id = 'ICF'),
    'uscf',     (SELECT COUNT(*) FROM federation_players WHERE federation_id = 'USCF'),
    'federation_total', (SELECT COUNT(*) FROM federation_players),
    'platform_total',   (SELECT COUNT(*) FROM platform_players),
    'total',    (SELECT COUNT(*) FROM federation_players)
              + (SELECT COUNT(*) FROM platform_players),
    -- Live crawl counters from the latest hourly snapshot. NULL if no
    -- snapshot has run yet — caller falls back to a static estimate.
    'chesscom_handles', (
      SELECT distinct_handles FROM corpus_index_counts
      WHERE source = 'chess.com'
      ORDER BY snapshot_at DESC LIMIT 1
    ),
    'lichess_handles', (
      SELECT distinct_handles FROM corpus_index_counts
      WHERE source = 'lichess'
      ORDER BY snapshot_at DESC LIMIT 1
    ),
    'chesscom_games', (
      SELECT total_games FROM corpus_index_counts
      WHERE source = 'chess.com'
      ORDER BY snapshot_at DESC LIMIT 1
    ),
    'lichess_games', (
      SELECT total_games FROM corpus_index_counts
      WHERE source = 'lichess'
      ORDER BY snapshot_at DESC LIMIT 1
    )
  );
$$;

-- Re-grant in case ALTER FUNCTION dropped the privilege.
GRANT EXECUTE ON FUNCTION public_index_stats TO anon, authenticated;
