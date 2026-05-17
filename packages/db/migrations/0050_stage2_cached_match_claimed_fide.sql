-- ============================================================================
-- Migration: 0050_stage2_cached_match_claimed_fide
--
-- Extends the stage2_cached_match RPC return to include claimed_fide_rating
-- and claimed_country. Both columns were added to platform_players in
-- migration 0049 (capture from chess.com .fide and Lichess
-- profile.fideRating). This migration exposes them through the RPC so
-- Stage 2 scoring can fold them into candidate confidence.
--
-- Why a separate component, not just folding into rating_band_match:
-- A self-reported FIDE rating is qualitatively sharper than an
-- online-rating ± offset heuristic. When the candidate themselves says
-- "I'm FIDE 2150" and our anchor is 2150 FIDE, that's a hard match — we
-- want Stage 2 to treat it as ~conclusive, not as a 1/n component of a
-- weighted average.
--
-- The TS scoring layer in apps/web/lib/scout/stage2.ts (and the worker
-- mirror) decides how to use the new columns; this migration just makes
-- them available. No change to the input parameters.
-- ============================================================================

DROP FUNCTION IF EXISTS stage2_cached_match(text[], text, int, real);

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
  claimed_fide_rating int,
  claimed_country text,
  sim real,
  matched_token text,
  claimed_name text,
  claimed_name_normalized text
) AS $$
  WITH trgm_arm AS (
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
      pp.claimed_fide_rating,
      pp.claimed_country,
      similarity(pp.handle_normalized, t)::real AS sim,
      t AS matched_token,
      pp.claimed_name,
      pp.claimed_name_normalized,
      row_number() OVER (
        PARTITION BY t ORDER BY similarity(pp.handle_normalized, t) DESC
      ) AS token_rn
    FROM platform_players pp
    CROSS JOIN unnest(name_tokens) AS t
    WHERE similarity(pp.handle_normalized, t) >= min_similarity
      AND (country_filter IS NULL OR pp.country = country_filter OR pp.country IS NULL)
  ),
  substr_arm AS (
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
      pp.claimed_fide_rating,
      pp.claimed_country,
      0.5::real AS sim,
      t AS matched_token,
      pp.claimed_name,
      pp.claimed_name_normalized,
      row_number() OVER (PARTITION BY t ORDER BY length(pp.handle_normalized)) AS token_rn
    FROM platform_players pp
    CROSS JOIN unnest(name_tokens) AS t
    WHERE length(t) >= 3
      AND pp.handle_normalized LIKE '%' || t || '%'
      AND (country_filter IS NULL OR pp.country = country_filter OR pp.country IS NULL)
  ),
  combined AS (
    SELECT * FROM trgm_arm WHERE token_rn <= per_token_limit
    UNION ALL
    SELECT * FROM substr_arm WHERE token_rn <= per_token_limit
  ),
  deduped AS (
    SELECT *,
      row_number() OVER (PARTITION BY platform, handle ORDER BY sim DESC) AS dedup_rn
    FROM combined
  )
  SELECT platform_player_id, platform, handle, country, title,
         rating_bullet, rating_blitz, rating_rapid, rating_classical,
         claimed_fide_rating, claimed_country,
         sim, matched_token, claimed_name, claimed_name_normalized
  FROM deduped
  WHERE dedup_rn = 1
  ORDER BY sim DESC;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION stage2_cached_match(text[], text, int, real) TO anon, authenticated;
