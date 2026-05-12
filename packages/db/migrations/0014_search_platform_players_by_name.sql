-- ============================================================================
-- search_platform_players_by_name — unified name search beyond FIDE
-- ============================================================================
-- The user's principle: every chess player, not just FIDE. This RPC lets
-- /scout fuzzy-match `name` input against:
--   - platform_players.claimed_name_normalized (chess.com profiles whose
--     bio gave us the real name — ~9,500 titled players after enrichment)
--   - platform_players.handle_normalized (catches "boris" inputs that
--     hit `boris-gelfand` even when claimed_name is missing)
-- Returns the best of either match per row, with the matched_field column
-- explaining which axis fired.
-- ============================================================================

CREATE OR REPLACE FUNCTION search_platform_players_by_name(
  q text,
  country_filter text DEFAULT NULL,
  limit_count int DEFAULT 20,
  min_similarity real DEFAULT 0.3
) RETURNS TABLE (
  id uuid,
  platform text,
  handle text,
  claimed_name text,
  country text,
  title text,
  rating_blitz int,
  rating_rapid int,
  rating_classical int,
  sim real,
  matched_field text
) AS $$
  WITH scored AS (
    SELECT
      pp.id, pp.platform, pp.handle, pp.claimed_name, pp.country, pp.title,
      pp.rating_blitz, pp.rating_rapid, pp.rating_classical,
      COALESCE(similarity(pp.claimed_name_normalized, q), 0) AS sim_name,
      similarity(pp.handle_normalized, q) AS sim_handle
    FROM platform_players pp
    WHERE
      (
        (pp.claimed_name_normalized IS NOT NULL AND pp.claimed_name_normalized % q)
        OR pp.handle_normalized % q
      )
      AND (country_filter IS NULL OR pp.country = country_filter)
  )
  SELECT
    id, platform, handle, claimed_name, country, title,
    rating_blitz, rating_rapid, rating_classical,
    GREATEST(sim_name, sim_handle) AS sim,
    CASE WHEN sim_name >= sim_handle THEN 'claimed_name' ELSE 'handle' END AS matched_field
  FROM scored
  WHERE GREATEST(sim_name, sim_handle) >= min_similarity
  ORDER BY GREATEST(sim_name, sim_handle) DESC
  LIMIT limit_count;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION search_platform_players_by_name(text, text, int, real) TO anon, authenticated;
