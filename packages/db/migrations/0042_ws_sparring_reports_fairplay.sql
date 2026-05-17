-- WS schema surfaces for sparring invitations, report sharing, fairplay
-- decisions, delisting, per-time-class ratings, coach relationships, and
-- Maia weight metadata.

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS delisted_at timestamptz,
  ADD COLUMN IF NOT EXISTS delist_reason text;

ALTER TABLE prep_reports
  ADD COLUMN IF NOT EXISTS share_token text;

CREATE UNIQUE INDEX IF NOT EXISTS prep_reports_share_token_idx
  ON prep_reports (share_token)
  WHERE share_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS challenge_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  inviter_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  invitee_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'accepted', 'declined', 'withdrawn', 'expired')
  ),
  message text,
  responded_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS challenge_invitations_invitee_idx
  ON challenge_invitations (invitee_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS challenge_invitations_challenge_idx
  ON challenge_invitations (challenge_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS challenge_invitations_pending_unique
  ON challenge_invitations (challenge_id, invitee_id)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS player_sparring_profiles (
  profile_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  opted_in boolean NOT NULL DEFAULT false,
  bio text,
  away_until timestamptz,
  last_online_at timestamptz,
  glicko_rating integer,
  completed_matches integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS player_sparring_profiles_directory_idx
  ON player_sparring_profiles (opted_in, last_online_at DESC, completed_matches DESC);

CREATE TABLE IF NOT EXISTS player_sparring_fees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  time_class text NOT NULL CHECK (time_class IN ('bullet', 'blitz', 'rapid', 'classical')),
  fee_cents integer NOT NULL CHECK (fee_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  funding_type text NOT NULL DEFAULT 'either' CHECK (funding_type IN ('cash', 'credits', 'either')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS player_sparring_fees_profile_time_class_unique
  ON player_sparring_fees (profile_id, time_class);

CREATE TABLE IF NOT EXISTS ratings_by_time_class (
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  time_class text NOT NULL CHECK (time_class IN ('bullet', 'blitz', 'rapid', 'classical')),
  rating numeric NOT NULL DEFAULT 1500,
  rd numeric NOT NULL DEFAULT 350,
  volatility numeric NOT NULL DEFAULT 0.06,
  games_played integer NOT NULL DEFAULT 0,
  last_updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (profile_id, time_class)
);

-- ban_actions.profile_id is ON DELETE RESTRICT so a hard-purge of a banned
-- profile fails loudly rather than silently erasing the ban record. A
-- soft-deleted (deleted_at IS NOT NULL) profile keeps its bans intact;
-- ops must explicitly reverse the ban before any hard delete.
CREATE TABLE IF NOT EXISTS ban_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  severity integer NOT NULL CHECK (severity BETWEEN 1 AND 6),
  reason text NOT NULL,
  evidence jsonb,
  forfeit_transaction_id uuid,
  applied_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  expires_at timestamptz,
  reversed_at timestamptz,
  reversed_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ban_actions_profile_idx
  ON ban_actions (profile_id, created_at DESC);

CREATE TABLE IF NOT EXISTS coach_students (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  student_profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'ended')),
  invited_at timestamptz NOT NULL DEFAULT NOW(),
  accepted_at timestamptz,
  ended_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS coach_students_pair_unique
  ON coach_students (coach_profile_id, student_profile_id);
CREATE INDEX IF NOT EXISTS coach_students_coach_idx
  ON coach_students (coach_profile_id);
CREATE INDEX IF NOT EXISTS coach_students_student_idx
  ON coach_students (student_profile_id);

CREATE TABLE IF NOT EXISTS maia_weights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  target_player_id uuid REFERENCES players(id) ON DELETE SET NULL,
  base_model text NOT NULL,
  version text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'training', 'ready', 'failed', 'deprecated')
  ),
  weights_url text,
  dataset_hash text,
  training_games_count integer,
  training_started_at timestamptz,
  training_finished_at timestamptz,
  error_text text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS maia_weights_target_profile_idx
  ON maia_weights (target_profile_id, status);
CREATE INDEX IF NOT EXISTS maia_weights_target_player_idx
  ON maia_weights (target_player_id, status);
