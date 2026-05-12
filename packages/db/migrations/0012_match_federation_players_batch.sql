-- ============================================================================
-- match_federation_players_batch — bulk cross-reference helper
-- ============================================================================
-- Given an array of normalized real names (e.g. claimed_name_normalized
-- values from platform_players), returns the best federation_players
-- match for each (similarity >= 0.5). Used by Stage 2 to drop candidates
-- whose claimed identity is a different FIDE player than the anchor.
-- ============================================================================

CREATE OR REPLACE FUNCTION match_federation_players_batch(
  names text[]
) RETURNS TABLE (
  name_input text,
  federation_player_id uuid,
  federation_id text,
  federation_player_id_str text,
  matched_name text,
  sim real
) AS $$
  SELECT DISTINCT ON (n)
    n AS name_input,
    fp.id AS federation_player_id,
    fp.federation_id,
    fp.federation_player_id AS federation_player_id_str,
    fp.name AS matched_name,
    similarity(fp.name_normalized, n) AS sim
  FROM unnest(names) AS n
  JOIN federation_players fp
    ON fp.name_normalized % n
   AND similarity(fp.name_normalized, n) >= 0.5
  ORDER BY n, similarity(fp.name_normalized, n) DESC;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION match_federation_players_batch(text[]) TO anon, authenticated;
