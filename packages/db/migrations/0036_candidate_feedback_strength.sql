-- ============================================================================
-- Four-level candidate feedback
-- ============================================================================
-- Users can now say whether a suggested account is:
--   correct            -- 100% right
--   probably_correct   -- not sure, feels right
--   probably_wrong     -- not sure, feels wrong
--   wrong              -- 100% wrong
--
-- Keep identification_candidates.user_confirmed as the legacy/public signal:
-- only "correct" maps to TRUE, only "wrong" maps to FALSE. The two uncertain
-- states are stored for learning and calibration without surfacing the account
-- as publicly confirmed.
-- ============================================================================

ALTER TABLE identification_candidates
  ADD COLUMN IF NOT EXISTS user_feedback text CHECK (
    user_feedback IN ('correct', 'probably_correct', 'probably_wrong', 'wrong')
  ),
  ADD COLUMN IF NOT EXISTS user_feedback_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS user_feedback_at timestamptz;

UPDATE identification_candidates
SET user_feedback = CASE
  WHEN user_confirmed IS TRUE THEN 'correct'
  WHEN user_confirmed IS FALSE THEN 'wrong'
  ELSE user_feedback
END
WHERE user_feedback IS NULL AND user_confirmed IS NOT NULL;

CREATE TABLE IF NOT EXISTS identification_candidate_feedback (
  id bigserial PRIMARY KEY,
  candidate_id bigint NOT NULL REFERENCES identification_candidates(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  feedback text NOT NULL CHECK (
    feedback IN ('correct', 'probably_correct', 'probably_wrong', 'wrong')
  ),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (candidate_id, user_id)
);

CREATE INDEX IF NOT EXISTS identification_candidate_feedback_candidate_idx
  ON identification_candidate_feedback (candidate_id);

CREATE INDEX IF NOT EXISTS identification_candidate_feedback_value_idx
  ON identification_candidate_feedback (feedback);
