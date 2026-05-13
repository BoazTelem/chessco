-- ============================================================================
-- Migration: 0022a_lock_search_path
-- Follow-up to 0022. Locks search_path on has_open_report / is_banned so a
-- malicious schema on the role's search_path can't shadow public.user_reports
-- or public.user_bans. Addresses Supabase advisor "function_search_path_mutable".
-- ============================================================================

CREATE OR REPLACE FUNCTION has_open_report(target uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_reports
    WHERE reported_id = target AND status IN ('open', 'investigating')
  );
$$;

CREATE OR REPLACE FUNCTION is_banned(target uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_bans
    WHERE profile_id = target AND lifted_at IS NULL
  );
$$;
