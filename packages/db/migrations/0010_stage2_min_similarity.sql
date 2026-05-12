-- ============================================================================
-- stage2_cached_match — tighter min_similarity default + drop old overload
-- ============================================================================
-- 0009 used the pg_trgm default similarity threshold (0.3), which lets
-- noise like "andrey_borisov" / "auntyboris" / "1952boris" through when
-- searching for the name "boris gelfand". Bumping to 0.4 cuts the
-- false-positive long tail without losing real matches.
--
-- New 4-arg signature; old 3-arg gets dropped so PostgREST doesn't
-- complain about ambiguous overloads.
-- ============================================================================

DROP FUNCTION IF EXISTS stage2_cached_match(text[], text, int);

CREATE OR REPLACE FUNCTION stage2_cached_match(
  name_tokens text[],
  country_filter text DEFAULT NULL,
  per_token_limit int DEFAULT 30,
  min_similarity real DEFAULT 0.4
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
    WHERE similarity(pp.handle_normalized, t) >= min_similarity
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

GRANT EXECUTE ON FUNCTION stage2_cached_match(text[], text, int, real) TO anon, authenticated;
