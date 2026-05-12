-- ============================================================================
-- stage2_cached_match RPC
-- ============================================================================
-- Returns the best-similarity row per (platform, handle) across all of the
-- given name tokens. Mirrors apps/workers/src/identification/cached-match.ts
-- so the web's /api/identify route can run Stage 2 without crossing the
-- app boundary.
-- ============================================================================

CREATE OR REPLACE FUNCTION stage2_cached_match(
  name_tokens text[],
  country_filter text DEFAULT NULL,
  per_token_limit int DEFAULT 30
) RETURNS TABLE (
  platform_player_id uuid,
  platform text,
  handle text,
  country text,
  title text,
  rating_bullet int,
  rating_blitz int,
  rating_rapid int,
  rating_classical int,
  sim real,
  matched_token text
) AS $$
  WITH per_token AS (
    SELECT
      pp.id AS platform_player_id,
      pp.platform,
      pp.handle,
      pp.country,
      pp.title,
      pp.rating_bullet,
      pp.rating_blitz,
      pp.rating_rapid,
      pp.rating_classical,
      similarity(pp.handle_normalized, t) AS sim,
      t AS matched_token,
      row_number() OVER (
        PARTITION BY t ORDER BY similarity(pp.handle_normalized, t) DESC
      ) AS token_rn
    FROM platform_players pp
    CROSS JOIN unnest(name_tokens) AS t
    WHERE pp.handle_normalized % t
      AND (country_filter IS NULL OR pp.country = country_filter OR pp.country IS NULL)
  ),
  deduped AS (
    SELECT *,
      row_number() OVER (PARTITION BY platform, handle ORDER BY sim DESC) AS dedup_rn
    FROM per_token
    WHERE token_rn <= per_token_limit
  )
  SELECT platform_player_id, platform, handle, country, title,
         rating_bullet, rating_blitz, rating_rapid, rating_classical,
         sim, matched_token
  FROM deduped
  WHERE dedup_rn = 1
  ORDER BY sim DESC;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION stage2_cached_match(text[], text, int) TO anon, authenticated;
