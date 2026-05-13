-- ============================================================================
-- Migration: 0018_index_stats_rpc
-- Phase 0 Week 7 — `/` and `/scout` show "X players indexed". Previously
-- hardcoded ("755,081", "868,194") and drifted on every monthly ingest.
-- This RPC returns live aggregates that callers cache via Next.js
-- `revalidate`. SECURITY DEFINER so anon callers don't pay the RLS
-- per-row cost on a COUNT(*).
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
              + (SELECT COUNT(*) FROM platform_players)
  );
$$;

GRANT EXECUTE ON FUNCTION public_index_stats TO anon, authenticated;

COMMENT ON FUNCTION public_index_stats IS
  'Aggregate counts of indexed players across federations and online platforms. Used by the home page hero banner.';
