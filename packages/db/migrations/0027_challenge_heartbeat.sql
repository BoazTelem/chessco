-- ============================================================================
-- Migration: 0027_challenge_heartbeat
-- Presence model for Practice challenges. A challenge is only matchable while
-- the creator is online; the client pings `last_heartbeat` every ~20 s and we
-- treat a row as stale once the heartbeat is older than 45 s. The lobby
-- filters stale rows out so opponents never accept a challenge whose creator
-- has gone offline and would leave them stranded on "Connecting…".
-- ============================================================================

ALTER TABLE challenges
  ADD COLUMN last_heartbeat timestamptz NOT NULL DEFAULT NOW();

-- Helps the lobby's status='open' AND last_heartbeat > NOW() - interval scan.
CREATE INDEX challenges_open_heartbeat_idx
  ON challenges (last_heartbeat DESC)
  WHERE status = 'open';
