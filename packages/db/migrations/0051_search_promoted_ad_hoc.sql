-- ============================================================================
-- Migration: 0051_search_promoted_ad_hoc
--
-- /scout's "Community-verified" section needs a trigram-matched lookup over
-- promoted ad-hoc players, with the most-confirmed (platform, handle) pair
-- attached so the result card can link to the canonical online profile.
--
-- Architecture: completes the cold-tail fallback loop from migrations 0047
-- (rating + promotion bookkeeping on ad_hoc_players) and 0048 (per-user
-- confirmation join table). When 2+ distinct users confirm the same
-- (ad_hoc_player_id, platform, handle), the nightly promote-ad-hoc worker
-- flips promotion_status to 'promoted'. This RPC is what makes promoted
-- rows surface in /scout queries by anyone else searching the same name.
--
-- Why a dedicated RPC rather than letting the page query directly:
--   - pg_trgm `%` operator isn't reachable from PostgREST/supabase-js.
--   - Joining ad_hoc_player_handles with COUNT(DISTINCT) + ROW_NUMBER()
--     needs server-side composition; PostgREST embedding can't express it.
--   - SECURITY DEFINER + search_path lockdown matches the pattern used by
--     search_federation_players (the canonical /scout RPC).
-- ============================================================================

CREATE OR REPLACE FUNCTION search_promoted_ad_hoc(
  q text,
  country_filter text DEFAULT NULL,
  limit_count int DEFAULT 10,
  min_similarity real DEFAULT 0.3
) RETURNS TABLE (
  id uuid,
  name text,
  country text,
  rating_estimate int,
  rating_band_low int,
  rating_band_high int,
  title text,
  confirmed_match_count int,
  last_confirmed_at timestamptz,
  sim real,
  top_platform text,
  top_handle text,
  top_handle_confirmer_count bigint
) AS $$
  WITH q_norm AS (
    SELECT
      lower(regexp_replace(
        translate(q, 'ÀÁÂÃÄÅàáâãäåÈÉÊËèéêëÌÍÎÏìíîïÒÓÔÕÖòóôõöÙÚÛÜùúûüÑñÇç',
                          'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuNnCc'),
        '[^a-zA-Z0-9 ]', '', 'g'
      )) AS qn
  ),
  base AS (
    SELECT
      ahp.id,
      ahp.name,
      ahp.country,
      ahp.rating_estimate,
      ahp.rating_band_low,
      ahp.rating_band_high,
      ahp.title,
      ahp.confirmed_match_count,
      ahp.last_confirmed_at,
      similarity(ahp.name_normalized, qn.qn) AS sim
    FROM ad_hoc_players ahp, q_norm qn
    WHERE ahp.promotion_status = 'promoted'
      AND ahp.name_normalized % qn.qn
      AND similarity(ahp.name_normalized, qn.qn) >= min_similarity
      AND (country_filter IS NULL OR ahp.country = upper(country_filter))
  ),
  handle_counts AS (
    SELECT
      h.ad_hoc_player_id,
      h.platform,
      h.handle,
      COUNT(DISTINCT h.confirmed_by) AS conf_count
    FROM ad_hoc_player_handles h
    JOIN base b ON b.id = h.ad_hoc_player_id
    GROUP BY h.ad_hoc_player_id, h.platform, h.handle
  ),
  ranked_handles AS (
    SELECT
      ad_hoc_player_id,
      platform,
      handle,
      conf_count,
      ROW_NUMBER() OVER (
        PARTITION BY ad_hoc_player_id
        ORDER BY conf_count DESC, platform, handle
      ) AS rn
    FROM handle_counts
  ),
  top_handles AS (
    SELECT ad_hoc_player_id, platform, handle, conf_count
    FROM ranked_handles
    WHERE rn = 1
  )
  SELECT
    b.id,
    b.name,
    b.country,
    b.rating_estimate,
    b.rating_band_low,
    b.rating_band_high,
    b.title,
    b.confirmed_match_count,
    b.last_confirmed_at,
    b.sim,
    th.platform AS top_platform,
    th.handle AS top_handle,
    th.conf_count AS top_handle_confirmer_count
  FROM base b
  LEFT JOIN top_handles th ON th.ad_hoc_player_id = b.id
  ORDER BY b.sim DESC, b.confirmed_match_count DESC
  LIMIT limit_count;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION search_promoted_ad_hoc(text, text, int, real) TO anon, authenticated;
