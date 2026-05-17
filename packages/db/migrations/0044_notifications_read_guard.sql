-- ============================================================================
-- Migration: 0044_notifications_read_guard
--
-- Tighten the notifications client update surface introduced in 0043.
-- RLS can restrict updates to a user's own rows, but it cannot restrict which
-- columns are updated. The bell only needs to set read_at, so authenticated
-- client updates are rejected if they change any other notification field.
--
-- Server-side writers use the direct Postgres/service-role connection and do
-- not have auth.uid(), so notification upserts can still refresh title/body,
-- merge data, clear read_at, and bump created_at.
-- ============================================================================

CREATE OR REPLACE FUNCTION notifications_client_read_at_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
      OR NEW.type IS DISTINCT FROM OLD.type
      OR NEW.category IS DISTINCT FROM OLD.category
      OR NEW.title IS DISTINCT FROM OLD.title
      OR NEW.body IS DISTINCT FROM OLD.body
      OR NEW.data IS DISTINCT FROM OLD.data
      OR NEW.action_url IS DISTINCT FROM OLD.action_url
      OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'notifications are read-only except read_at'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS notifications_client_read_at_only ON notifications;
CREATE TRIGGER notifications_client_read_at_only
  BEFORE UPDATE ON notifications
  FOR EACH ROW
  EXECUTE FUNCTION notifications_client_read_at_only();
