-- ============================================================================
-- Migration: 0028_profile_visibility
-- Free per-user privacy setting. Independent of the per-challenge
-- challenges.anonymous toggle (which stays as-is). A user can be globally
-- public yet post one anonymous challenge, or globally private yet name
-- themselves on a specific challenge — two independent levers.
-- ============================================================================

ALTER TABLE profiles
  ADD COLUMN profile_visibility text NOT NULL DEFAULT 'public'
    CHECK (profile_visibility IN ('public', 'private', 'coach_public_player_private'));

-- Cheap partial index for the lobby card join — we only need to know whether
-- a creator's profile is publicly linkable, not the full enum.
CREATE INDEX profiles_public_visibility_idx
  ON profiles (id)
  WHERE deleted_at IS NULL AND profile_visibility = 'public';
