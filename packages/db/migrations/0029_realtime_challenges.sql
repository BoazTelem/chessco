-- ============================================================================
-- Migration: 0028_realtime_challenges
-- Publish the `challenges` table so the Practice lobby can react in real time
-- when a new challenge is published — viewers should not have to refresh to
-- see a fresh card. RLS (challenges_select_open) is still enforced per
-- subscriber, so only rows the viewer would have seen on a fresh page-load
-- are ever delivered.
-- ============================================================================

ALTER PUBLICATION supabase_realtime ADD TABLE challenges;
