-- ============================================================================
-- Migration: 0023_practice_prefs
-- Practice module v1 — per-user board/sound/piece preferences for the live
-- game UI and review board. One row per profile, lazy-created on first edit
-- (the GET endpoint returns the defaults if no row exists).
-- ============================================================================

CREATE TABLE user_practice_prefs (
  profile_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  board_theme text NOT NULL DEFAULT 'classic'
    CHECK (board_theme IN ('classic', 'wood', 'green', 'blue', 'gray')),
  piece_set text NOT NULL DEFAULT 'cburnett'
    CHECK (piece_set IN ('cburnett', 'merida', 'alpha', 'staunton')),
  sound_enabled boolean NOT NULL DEFAULT true,
  animations_enabled boolean NOT NULL DEFAULT true,
  premoves_enabled boolean NOT NULL DEFAULT true,
  auto_promote_queen boolean NOT NULL DEFAULT false,
  show_legal_moves boolean NOT NULL DEFAULT true,
  show_coordinates boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TRIGGER user_practice_prefs_set_updated_at
  BEFORE UPDATE ON user_practice_prefs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- RLS: each user reads/writes only their own row. service_role bypasses.
-- ----------------------------------------------------------------------------
ALTER TABLE user_practice_prefs ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_practice_prefs_own ON user_practice_prefs
  FOR ALL USING (profile_id = auth.uid()) WITH CHECK (profile_id = auth.uid());
