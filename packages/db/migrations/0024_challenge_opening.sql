-- ============================================================================
-- Migration: 0024_challenge_opening
-- Tag challenges with an optional opening name + ECO code so the lobby can
-- filter by opening. v1 ships with self-tagging (user types it on create);
-- auto-detection from arbitrary FEN/PGN can layer on later.
-- ============================================================================

ALTER TABLE challenges
  ADD COLUMN opening_name text,
  ADD COLUMN eco_code varchar(5);

-- Length sanity on the free-text opening name (matches the client-side limit).
ALTER TABLE challenges
  ADD CONSTRAINT challenges_opening_name_len
  CHECK (opening_name IS NULL OR char_length(opening_name) <= 80);

-- Index for the lobby's opening dropdown — distinct open-challenge opening names.
CREATE INDEX challenges_opening_open_idx
  ON challenges (opening_name)
  WHERE status = 'open' AND opening_name IS NOT NULL;
