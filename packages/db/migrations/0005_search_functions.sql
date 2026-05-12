-- ============================================================================
-- Migration: 0005_search_functions
-- Phase 0 Week 6 — `/scout` MVP. Trigram-fuzzy player search exposed as a
-- Supabase RPC so the web app can call it via supabase.rpc(...).
-- ============================================================================

CREATE OR REPLACE FUNCTION search_federation_players(
  q text DEFAULT '',
  country_filter text DEFAULT NULL,
  rating_min int DEFAULT NULL,
  rating_max int DEFAULT NULL,
  federation_filter text DEFAULT NULL,
  title_filter text DEFAULT NULL,
  page_size int DEFAULT 20,
  page_offset int DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  federation_id text,
  federation_player_id text,
  name text,
  country text,
  title text,
  rating_standard int,
  rating_rapid int,
  rating_blitz int,
  birth_year int,
  score real,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  normalized_q text;
BEGIN
  normalized_q := lower(trim(coalesce(q, '')));

  RETURN QUERY
  WITH matches AS (
    SELECT
      fp.id,
      fp.federation_id,
      fp.federation_player_id,
      fp.name,
      fp.country,
      fp.title,
      fp.rating_standard,
      fp.rating_rapid,
      fp.rating_blitz,
      fp.birth_year,
      CASE
        WHEN normalized_q = '' THEN 0.0::real
        ELSE similarity(fp.name_normalized, normalized_q)
      END AS score
    FROM federation_players fp
    WHERE
      (normalized_q = '' OR fp.name_normalized % normalized_q)
      AND (country_filter IS NULL OR fp.country = country_filter)
      AND (rating_min IS NULL OR fp.rating_standard >= rating_min)
      AND (rating_max IS NULL OR fp.rating_standard <= rating_max)
      AND (federation_filter IS NULL OR fp.federation_id = federation_filter)
      AND (title_filter IS NULL OR fp.title = title_filter)
  ),
  counted AS (
    SELECT COUNT(*)::bigint AS total FROM matches
  )
  SELECT
    m.id,
    m.federation_id,
    m.federation_player_id,
    m.name,
    m.country,
    m.title,
    m.rating_standard,
    m.rating_rapid,
    m.rating_blitz,
    m.birth_year,
    m.score,
    c.total AS total_count
  FROM matches m, counted c
  ORDER BY m.score DESC NULLS LAST, m.rating_standard DESC NULLS LAST
  LIMIT page_size OFFSET page_offset;
END;
$$;

GRANT EXECUTE ON FUNCTION search_federation_players TO anon, authenticated;
