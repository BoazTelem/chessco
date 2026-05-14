-- 0031_challenge_target_opponent.sql
--
-- Adds optional `target_opponent_id` to challenges so a creator can issue a
-- direct invite to a specific online user. A targeted challenge:
--   * never appears in the public lobby (challenges_select_open used to grant
--     visibility to anyone on status='open' — we now exclude targeted rows
--     from the public path and add a separate policy for the invitee)
--   * can only be accepted by the named opponent
--   * is always free (fee_cents = 0), enforced by the /api/practice/invites
--     route, not at the DB layer (the column itself stays flexible)

ALTER TABLE challenges
  ADD COLUMN IF NOT EXISTS target_opponent_id uuid REFERENCES profiles(id) ON DELETE SET NULL;

-- Hot path for the invitee's "do I have pending invites?" subscription.
CREATE INDEX IF NOT EXISTS challenges_target_open_idx
  ON challenges (target_opponent_id, status)
  WHERE status = 'open' AND target_opponent_id IS NOT NULL;

-- Replace the public-lobby SELECT policy so targeted invites stay hidden from
-- the lobby (status='open' alone isn't enough anymore), and add a separate
-- policy granting the invitee SELECT access to their own pending invites.
-- Creators retain visibility into all their own rows via creator_id check.
DROP POLICY IF EXISTS challenges_select_open ON challenges;

CREATE POLICY challenges_select_open ON challenges
  FOR SELECT USING (
    (status = 'open' AND target_opponent_id IS NULL)  -- public lobby
    OR creator_id = auth.uid()                         -- own rows
    OR target_opponent_id = auth.uid()                 -- you are the invitee
  );
