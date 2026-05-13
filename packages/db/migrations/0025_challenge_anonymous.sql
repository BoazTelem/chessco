-- ============================================================================
-- Migration: 0025_challenge_anonymous
-- Privacy option on challenges: creator can publish anonymously so the lobby
-- hides their name/handle. We also snapshot the creator's best-known rating
-- at publish time so the lobby can show "Anonymous · 2068" without joining
-- external_accounts at query time.
-- ============================================================================

ALTER TABLE challenges
  ADD COLUMN anonymous boolean NOT NULL DEFAULT false,
  ADD COLUMN creator_rating integer;

-- Sanity bound on the snapshotted rating.
ALTER TABLE challenges
  ADD CONSTRAINT challenges_creator_rating_range
  CHECK (creator_rating IS NULL OR (creator_rating BETWEEN 0 AND 3500));
