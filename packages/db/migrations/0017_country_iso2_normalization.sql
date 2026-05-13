-- ============================================================================
-- Migration: 0017_country_iso2_normalization
-- Phase 0 Week 7 — federations don't agree on country code format.
--   FIDE uses alpha-3 ("USA", "ISR", "GER")
--   ICF stores alpha-2 ("IL")
--   USCF will store alpha-2 ("US")
-- The /scout country filter previously matched on raw equality, so a
-- user typing "USA" would hit FIDE-USA rows but miss USCF/ICF rows, and
-- vice versa. Rather than backfill 760k FIDE rows we normalize on read.
--
-- This migration:
--   1. Adds `country_iso2(text)` — a stable IMMUTABLE function that
--      returns the ISO-3166-1 alpha-2 form of any FIDE / alpha-2 / common
--      alias. Unknown inputs pass through uppercased.
--   2. Rewrites `search_federation_players` to compare normalized codes
--      on both sides. Existing call sites unchanged — they keep passing
--      raw user input ("USA", "ISR", "US", "IL"); the RPC normalizes.
-- ============================================================================

CREATE OR REPLACE FUNCTION country_iso2(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE upper(coalesce(trim(input), ''))
    -- Already alpha-2
    WHEN ''    THEN NULL
    WHEN 'IL'  THEN 'IL'
    WHEN 'US'  THEN 'US'
    WHEN 'GB'  THEN 'GB'
    -- FIDE alpha-3 → ISO alpha-2
    WHEN 'ISR' THEN 'IL'
    WHEN 'USA' THEN 'US'
    WHEN 'GBR' THEN 'GB'
    WHEN 'ENG' THEN 'GB'
    WHEN 'CAN' THEN 'CA'
    WHEN 'AUS' THEN 'AU'
    WHEN 'GER' THEN 'DE'
    WHEN 'FRA' THEN 'FR'
    WHEN 'ITA' THEN 'IT'
    WHEN 'ESP' THEN 'ES'
    WHEN 'NED' THEN 'NL'
    WHEN 'NOR' THEN 'NO'
    WHEN 'SWE' THEN 'SE'
    WHEN 'DEN' THEN 'DK'
    WHEN 'FIN' THEN 'FI'
    WHEN 'ISL' THEN 'IS'
    WHEN 'RUS' THEN 'RU'
    WHEN 'UKR' THEN 'UA'
    WHEN 'POL' THEN 'PL'
    WHEN 'CZE' THEN 'CZ'
    WHEN 'SVK' THEN 'SK'
    WHEN 'HUN' THEN 'HU'
    WHEN 'ROU' THEN 'RO'
    WHEN 'BUL' THEN 'BG'
    WHEN 'SRB' THEN 'RS'
    WHEN 'CRO' THEN 'HR'
    WHEN 'SLO' THEN 'SI'
    WHEN 'GRE' THEN 'GR'
    WHEN 'TUR' THEN 'TR'
    WHEN 'ARM' THEN 'AM'
    WHEN 'AZE' THEN 'AZ'
    WHEN 'GEO' THEN 'GE'
    WHEN 'IND' THEN 'IN'
    WHEN 'CHN' THEN 'CN'
    WHEN 'JPN' THEN 'JP'
    WHEN 'KOR' THEN 'KR'
    WHEN 'IRI' THEN 'IR'
    WHEN 'KAZ' THEN 'KZ'
    WHEN 'UZB' THEN 'UZ'
    WHEN 'VIE' THEN 'VN'
    WHEN 'PHI' THEN 'PH'
    WHEN 'INA' THEN 'ID'
    WHEN 'SGP' THEN 'SG'
    WHEN 'AUT' THEN 'AT'
    WHEN 'SUI' THEN 'CH'
    WHEN 'BEL' THEN 'BE'
    WHEN 'IRL' THEN 'IE'
    WHEN 'POR' THEN 'PT'
    WHEN 'EST' THEN 'EE'
    WHEN 'LAT' THEN 'LV'
    WHEN 'LTU' THEN 'LT'
    WHEN 'BLR' THEN 'BY'
    WHEN 'MEX' THEN 'MX'
    WHEN 'ARG' THEN 'AR'
    WHEN 'BRA' THEN 'BR'
    WHEN 'CHI' THEN 'CL'
    WHEN 'COL' THEN 'CO'
    WHEN 'PER' THEN 'PE'
    WHEN 'VEN' THEN 'VE'
    WHEN 'URU' THEN 'UY'
    WHEN 'PAR' THEN 'PY'
    WHEN 'CUB' THEN 'CU'
    WHEN 'RSA' THEN 'ZA'
    WHEN 'EGY' THEN 'EG'
    WHEN 'MAR' THEN 'MA'
    WHEN 'TUN' THEN 'TN'
    WHEN 'ALG' THEN 'DZ'
    WHEN 'NGR' THEN 'NG'
    WHEN 'NZL' THEN 'NZ'
    -- Anything else: pass through. If the value is already a valid
    -- alpha-2 we keep it; if it's an obscure alpha-3 the equality
    -- check still matches against itself.
    ELSE upper(trim(input))
  END;
$$;

GRANT EXECUTE ON FUNCTION country_iso2(text) TO anon, authenticated;

-- Rewrite the search RPC to normalize both sides.
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
  normalized_country text;
BEGIN
  normalized_q := lower(trim(coalesce(q, '')));
  normalized_country := country_iso2(country_filter);

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
      AND (normalized_country IS NULL OR country_iso2(fp.country) = normalized_country)
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

-- Functional index so a normalized country filter remains seekable. Without
-- this, `country_iso2(fp.country) = ?` forces a sequential filter after the
-- trigram GIN match (acceptable for narrow name queries today but bad for
-- "show all FIDE rows from country=X" listings we'll add post-Phase-2).
CREATE INDEX IF NOT EXISTS federation_players_country_iso2_idx
  ON federation_players (country_iso2(country));

COMMENT ON FUNCTION country_iso2(text) IS
  'Normalize a country code (FIDE alpha-3, ISO alpha-2, or common alias) to ISO-3166-1 alpha-2. Unknown inputs uppercased and passed through.';
