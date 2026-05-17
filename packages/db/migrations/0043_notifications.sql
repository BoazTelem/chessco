-- ============================================================================
-- Migration: 0043_notifications
-- In-app notifications + per-category email preferences.
--
-- Notifications are produced server-side from existing trigger sites (admin
-- ban/warn flows, fairplay decide route, credit grant helpers, sparring
-- invitations). Inserts run through the practice DB (service role) which
-- bypasses RLS; clients can only SELECT/UPDATE their own rows.
--
-- The realtime publication lets the browser bell subscribe to INSERTs filtered
-- by profile_id, matching the pattern used by matches/challenges (migrations
-- 0026, 0029).
-- ============================================================================

CREATE TABLE IF NOT EXISTS notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id   uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type         text NOT NULL,
  category     text NOT NULL CHECK (category IN ('moderation', 'credits', 'social')),
  title        text NOT NULL,
  body         text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  action_url   text,
  -- When set, the partial UNIQUE collapses repeated inserts (e.g. multiple
  -- practice rewards earned against the same opponent in the same day land
  -- as a single row with data.amount summed on UPSERT).
  dedupe_key   text,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notifications_profile_unread_idx
  ON notifications (profile_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS notifications_profile_idx
  ON notifications (profile_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_idx
  ON notifications (profile_id, type, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notifications_select_own ON notifications;
CREATE POLICY notifications_select_own ON notifications
  FOR SELECT USING (profile_id = auth.uid());

-- Clients can only flip read_at on their own rows. WITH CHECK prevents
-- moving a row to another profile via UPDATE.
DROP POLICY IF EXISTS notifications_update_own_read ON notifications;
CREATE POLICY notifications_update_own_read ON notifications
  FOR UPDATE
  USING (profile_id = auth.uid())
  WITH CHECK (profile_id = auth.uid());

-- No INSERT / DELETE policies. All inserts happen server-side via the
-- practice DB pool (service role connection) which bypasses RLS.

-- ----------------------------------------------------------------------------
-- Per-category email preferences. In-app notifications are always on; only
-- the email side is opt-out. Defaults are TRUE so existing users get emails
-- for high-signal events unless they explicitly turn them off.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notification_email_preferences (
  profile_id        uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  moderation_email  boolean NOT NULL DEFAULT TRUE,
  credits_email     boolean NOT NULL DEFAULT TRUE,
  social_email      boolean NOT NULL DEFAULT TRUE,
  updated_at        timestamptz NOT NULL DEFAULT NOW()
);

ALTER TABLE notification_email_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS nep_select_own ON notification_email_preferences;
CREATE POLICY nep_select_own ON notification_email_preferences
  FOR SELECT USING (profile_id = auth.uid());

DROP POLICY IF EXISTS nep_insert_own ON notification_email_preferences;
CREATE POLICY nep_insert_own ON notification_email_preferences
  FOR INSERT WITH CHECK (profile_id = auth.uid());

DROP POLICY IF EXISTS nep_update_own ON notification_email_preferences;
CREATE POLICY nep_update_own ON notification_email_preferences
  FOR UPDATE
  USING (profile_id = auth.uid())
  WITH CHECK (profile_id = auth.uid());

-- ----------------------------------------------------------------------------
-- Enable Supabase realtime on notifications so the browser bell can subscribe
-- to INSERTs filtered by profile_id. Guarded for idempotency.
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'notifications'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE notifications';
  END IF;
END
$$;
