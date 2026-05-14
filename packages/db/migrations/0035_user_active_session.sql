-- ============================================================================
-- Migration: 0035_user_active_session
-- Single-session enforcement. When a user signs in on a new device/browser,
-- the previous session should be kicked out immediately.
--
-- Mechanism:
--   1. /auth/callback writes the new login's session_id (from the Supabase
--      JWT) into this table and calls admin.signOut(jwt, 'others') to revoke
--      every other refresh token for that user.
--   2. The browser-side SessionGuard subscribes to UPDATEs on this row via
--      Supabase Realtime; when session_id changes to something other than
--      its own, it calls signOut() and redirects to /login.
--   3. Revoked refresh tokens are the defense-in-depth fallback: even if
--      the Realtime event is missed, the old browser is signed out the
--      moment its short-lived access token expires (~1 h).
-- ============================================================================

CREATE TABLE user_active_session (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

ALTER TABLE user_active_session ENABLE ROW LEVEL SECURITY;

-- Users can read their own row so SessionGuard can compare on mount and
-- receive Realtime UPDATEs (Realtime evaluates SELECT policies per subscriber).
CREATE POLICY user_active_session_select_own ON user_active_session
  FOR SELECT USING (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policy: only the service-role client (used by
-- /auth/callback) writes this table. RLS denies everything else.

-- Realtime UPDATE payloads need the full row so the client can read the new
-- session_id reliably across pg versions.
ALTER TABLE user_active_session REPLICA IDENTITY FULL;

ALTER PUBLICATION supabase_realtime ADD TABLE user_active_session;
