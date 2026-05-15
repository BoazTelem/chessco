-- ============================================================================
-- Migration: 0041_search_events
--
-- Audit feed for the super-admin view at /admin/super/searches.
--
-- Records every user-driven search and find across four kinds:
--
--   scout_query     /scout submit (text-input search across FIDE/chess.com/lichess)
--   prepare_verify  POST /api/prepare/verify (platform+handle confirmation)
--   prep_visit      landing on /prepare/[platform]/[handle] (the "found whom" event)
--   leak_reveal     prep_leak_unlocks insert (both paid reveals and auto-unlocks)
--
-- Anonymous visitors are identified by a salted HMAC of their IP plus Vercel-
-- supplied geo (city, country, region). Raw IPs are never persisted. A
-- session_id cookie (issued by middleware) correlates each visitor's events
-- across signed-in / signed-out transitions.
--
-- No SELECT/INSERT RLS policies are written: the table is service-role-only
-- (writes from apps/web/lib/search-events/log.ts via getPracticeDb(); reads
-- from /admin/super/searches via createAdminClient()).
-- ============================================================================

CREATE TABLE search_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at       timestamptz NOT NULL DEFAULT NOW(),
  kind              text NOT NULL CHECK (kind IN
                      ('scout_query', 'prepare_verify', 'prep_visit', 'leak_reveal')),

  -- Identity. profile_id is set when the user was signed in at event time.
  -- ip_hash is set when we had a client IP to hash. Both can coexist when a
  -- signed-in user is still carrying their pre-login session cookie.
  profile_id        uuid REFERENCES profiles(id) ON DELETE SET NULL,
  search_session_id uuid,
  ip_hash           text,
  ip_geo_city       text,
  ip_geo_country    text,
  ip_geo_region     text,
  user_agent_hash   text,

  -- Per-kind payload. All nullable; only the fields meaningful to the kind
  -- are populated.
  query_text        text,
  target_platform   text CHECK (target_platform IS NULL
                                OR target_platform IN ('lichess', 'chess.com')),
  target_handle     text,
  result_count      int,
  leak_fingerprint  text,
  cost_credits      int,
  extra             jsonb
);

CREATE INDEX search_events_occurred_at_idx
  ON search_events (occurred_at DESC);
CREATE INDEX search_events_profile_idx
  ON search_events (profile_id, occurred_at DESC)
  WHERE profile_id IS NOT NULL;
CREATE INDEX search_events_session_idx
  ON search_events (search_session_id, occurred_at)
  WHERE search_session_id IS NOT NULL;
CREATE INDEX search_events_kind_idx
  ON search_events (kind, occurred_at DESC);
CREATE INDEX search_events_target_idx
  ON search_events (target_platform, target_handle, occurred_at DESC)
  WHERE target_handle IS NOT NULL;
CREATE INDEX search_events_ip_hash_idx
  ON search_events (ip_hash, occurred_at DESC)
  WHERE ip_hash IS NOT NULL;

ALTER TABLE search_events ENABLE ROW LEVEL SECURITY;
