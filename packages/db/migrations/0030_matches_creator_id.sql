-- ============================================================================
-- Migration: 0030_matches_creator_id
-- Denormalizes challenge.creator_id onto matches so Realtime postgres_changes
-- can authorize delivery to the creator without a cross-table EXISTS join.
--
-- Why: Supabase Realtime applies RLS per-event, and complex policies with
-- joins/EXISTS frequently fail to authorize delivery (the trivial branch —
-- opponent_id = auth.uid() — works in isolation but the creator branch
-- silently drops the event). After this migration the policy reads from a
-- single row, no joins, no EXISTS, and the publisher's auto-redirect works.
-- ============================================================================

ALTER TABLE matches ADD COLUMN creator_id uuid REFERENCES profiles(id);

UPDATE matches m
SET creator_id = c.creator_id
FROM challenges c
WHERE m.challenge_id = c.id AND m.creator_id IS NULL;

ALTER TABLE matches ALTER COLUMN creator_id SET NOT NULL;
CREATE INDEX matches_creator_id_status_idx ON matches (creator_id, status);

DROP POLICY IF EXISTS matches_select_participant ON matches;
CREATE POLICY matches_select_participant ON matches
  FOR SELECT USING (opponent_id = auth.uid() OR creator_id = auth.uid());
