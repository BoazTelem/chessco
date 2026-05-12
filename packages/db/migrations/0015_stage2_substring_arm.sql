-- ============================================================================
-- stage2_cached_match — add substring-containment arm
-- ============================================================================
-- Per-token trigram similarity falls below the 0.4 cutoff when a short name
-- token is buried inside a longer handle. Example: similarity('omermizrahi1',
-- 'omer') = 0.29 and similarity('omermizrahi1', 'mizrahi') = 0.31 — neither
-- crosses the threshold, so an obvious match like "Mizrahi, Omer" →
-- chess.com/omermizrahi1 was invisible to Stage 2.
--
-- The TS layer already has compoundContainmentSim that boosts these to 1.0,
-- but it only runs on rows the SQL returned. This adds a second arm that
-- matches handle_normalized LIKE '%' || token || '%' (uses the existing GIN
-- trgm index for tokens >= 3 chars). Synthesized sim = 0.5 so substring hits
-- still rank below clean trigram hits; the TS containment boost then lifts
-- multi-token containment cases to 1.0 as before.
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
  -- Substring containment arm — catches buried short tokens. Restricted to
  -- tokens >= 3 chars so the GIN trgm index can serve the LIKE. We synthesize
  -- a fixed sim = 0.5 here; the TS compoundContainmentSim boost lifts true
  -- multi-token hits to 1.0 in scoring.
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
         sim, matched_token, claimed_name, claimed_name_normalized
  FROM deduped
  WHERE dedup_rn = 1
  ORDER BY sim DESC;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION stage2_cached_match(text[], text, int, real) TO anon, authenticated;
