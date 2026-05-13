-- ============================================================================
-- Migration: 0026_realtime_matches
-- Publish the `matches` table to the supabase_realtime publication so the
-- lobby can subscribe to INSERTs and auto-redirect a challenge creator the
-- moment their position is accepted. RLS (matches_select_participant) is
-- still enforced per-subscriber, so only the two participants receive the
-- event for any given row.
-- ============================================================================

ALTER PUBLICATION supabase_realtime ADD TABLE matches;
