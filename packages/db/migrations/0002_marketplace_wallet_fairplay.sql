-- ============================================================================
-- Migration: 0002_marketplace_wallet_fairplay
-- Phase 0 Week 2 — marketplace, wallet/ledger, rating, refunds, fairplay,
-- audit. Spec §5 v1.1 — second half of the schema.
-- ============================================================================

-- ============================================================================
-- MARKETPLACE
-- ============================================================================

CREATE TABLE challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  fen text NOT NULL,
  pgn_prefix text,
  creator_color char(1) CHECK (creator_color IN ('w', 'b')),
  time_control text NOT NULL,
  time_class text NOT NULL CHECK (time_class IN ('bullet', 'blitz', 'rapid', 'classical')),
  fee_cents integer NOT NULL CHECK (fee_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  rating_min integer,
  rating_max integer,
  required_trust_score integer DEFAULT 50,
  games_requested integer NOT NULL DEFAULT 1 CHECK (games_requested > 0),
  games_completed integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'matched', 'completed', 'cancelled', 'expired')),
  expires_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE TRIGGER challenges_set_updated_at BEFORE UPDATE ON challenges
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX challenges_creator_id_idx ON challenges (creator_id);
CREATE INDEX challenges_open_lobby_idx
  ON challenges (time_class, rating_min, rating_max)
  WHERE status = 'open';

-- live_games is forward-declared because matches references it.
-- We'll create matches first with the FK deferred.

CREATE TABLE matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  opponent_id uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  fee_cents integer NOT NULL,
  platform_fee_cents integer NOT NULL,
  opponent_payout_cents integer NOT NULL,
  status text NOT NULL DEFAULT 'accepted' CHECK (status IN (
    'accepted', 'starting', 'live', 'completed', 'aborted',
    'abandoned', 'creator_abandoned', 'disputed', 'settled'
  )),
  accepted_at timestamptz NOT NULL DEFAULT NOW(),
  started_at timestamptz,
  completed_at timestamptz,
  settled_at timestamptz,
  game_id uuid,                       -- FK to live_games added below
  review_window_expires_at timestamptz
);
CREATE INDEX matches_opponent_id_status_idx ON matches (opponent_id, status);
CREATE INDEX matches_challenge_id_idx ON matches (challenge_id);

CREATE TABLE live_games (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL UNIQUE REFERENCES matches(id) ON DELETE CASCADE,
  white_user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  black_user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  initial_fen text NOT NULL,
  pgn text,
  current_fen text,
  time_control text NOT NULL,
  white_time_ms integer,
  black_time_ms integer,
  result text CHECK (result IN ('1-0', '0-1', '1/2-1/2', '*')),
  termination text,
  status text NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'completed', 'aborted', 'abandoned')),
  started_at timestamptz NOT NULL DEFAULT NOW(),
  completed_at timestamptz
);

-- Add deferred FK matches.game_id -> live_games.id
ALTER TABLE matches
  ADD CONSTRAINT matches_game_id_fkey
  FOREIGN KEY (game_id) REFERENCES live_games(id) ON DELETE SET NULL;

CREATE TABLE match_moves (
  id bigserial PRIMARY KEY,
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  ply integer NOT NULL,
  san text NOT NULL,
  uci text NOT NULL,
  time_remaining_ms integer,
  client_timestamp timestamptz,
  server_timestamp timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX match_moves_match_ply_idx ON match_moves (match_id, ply);

-- ============================================================================
-- WALLET & LEDGER (double-entry)
-- ============================================================================

CREATE TABLE wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  available_cents integer NOT NULL DEFAULT 0,
  pending_cents integer NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'USD',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CHECK (available_cents >= 0 AND pending_cents >= 0)
);
CREATE TRIGGER wallets_set_updated_at BEFORE UPDATE ON wallets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL,
  account_type text NOT NULL CHECK (account_type IN (
    'user_wallet', 'platform_revenue', 'escrow', 'stripe_clearing', 'refund_reserve'
  )),
  account_id uuid,
  direction char(1) NOT NULL CHECK (direction IN ('D', 'C')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency char(3) NOT NULL,
  category text NOT NULL CHECK (category IN (
    'deposit', 'match_escrow', 'match_payout', 'platform_fee',
    'withdrawal', 'refund', 'reversal'
  )),
  reference_type text CHECK (reference_type IN ('match', 'stripe_payment', 'payout', 'manual')),
  reference_id text,
  reversible_until timestamptz,
  reversed_by uuid REFERENCES ledger_entries(id),
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX ledger_entries_transaction_idx ON ledger_entries (transaction_id);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_type, account_id, created_at DESC);

CREATE TABLE stripe_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  payload jsonb NOT NULL,
  processed boolean DEFAULT false,
  processed_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX stripe_events_processed_idx ON stripe_events (processed, received_at);

-- ============================================================================
-- RATING & TRUST
-- ============================================================================

CREATE TABLE ratings (
  profile_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  skill_rating numeric NOT NULL DEFAULT 1500,
  skill_rd numeric NOT NULL DEFAULT 350,
  skill_volatility numeric NOT NULL DEFAULT 0.06,
  trust_score integer NOT NULL DEFAULT 50 CHECK (trust_score BETWEEN 0 AND 100),
  trust_tier text NOT NULL DEFAULT 'new' CHECK (trust_tier IN ('new', 'bronze', 'silver', 'gold', 'platinum')),
  paid_games_completed integer NOT NULL DEFAULT 0,
  paid_games_abandoned integer NOT NULL DEFAULT 0,
  refunds_filed integer NOT NULL DEFAULT 0,
  refunds_granted integer NOT NULL DEFAULT 0,
  refunds_denied integer NOT NULL DEFAULT 0,
  fairplay_flags integer NOT NULL DEFAULT 0,
  last_recalculated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE rating_history (
  id bigserial PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  match_id uuid REFERENCES matches(id) ON DELETE SET NULL,
  skill_rating_before numeric,
  skill_rating_after numeric,
  trust_score_before integer,
  trust_score_after integer,
  reason text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX rating_history_profile_idx ON rating_history (profile_id, created_at DESC);

-- ============================================================================
-- REFUNDS
-- ============================================================================

CREATE TABLE refund_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  requester_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  respondent_id uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  reason_code text NOT NULL CHECK (reason_code IN (
    'opponent_abandoned',
    'opponent_didnt_play_position',
    'engine_assistance_suspected',
    'harassment',
    'technical_failure',
    'other'
  )),
  reason_detail text,
  evidence jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'auto_approved', 'under_review', 'approved', 'denied', 'reversed'
  )),
  amount_cents integer NOT NULL,
  resolution_notes text,
  resolved_by uuid REFERENCES profiles(id),
  auto_resolution_rule text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  resolved_at timestamptz
);
CREATE INDEX refund_requests_status_idx ON refund_requests (status, created_at);
CREATE INDEX refund_requests_match_idx ON refund_requests (match_id);

-- ============================================================================
-- ANTI-CHEAT
-- ============================================================================

CREATE TABLE fairplay_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  match_id uuid REFERENCES matches(id) ON DELETE SET NULL,
  game_id uuid REFERENCES games(id) ON DELETE SET NULL,
  flag_type text NOT NULL CHECK (flag_type IN (
    'engine_correlation', 'tab_switching', 'time_pattern', 'manual_report', 'sandbagging'
  )),
  severity integer NOT NULL CHECK (severity BETWEEN 1 AND 10),
  signals jsonb,
  reviewed_by uuid REFERENCES profiles(id),
  outcome text CHECK (outcome IN ('confirmed', 'dismissed', 'pending')) DEFAULT 'pending',
  action_taken text CHECK (action_taken IN ('none', 'warning', 'paid_play_suspended', 'banned')),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  reviewed_at timestamptz
);
CREATE INDEX fairplay_flags_profile_idx ON fairplay_flags (profile_id);
CREATE INDEX fairplay_flags_review_queue_idx
  ON fairplay_flags (severity DESC, created_at) WHERE outcome = 'pending';

CREATE TABLE fairplay_telemetry (
  id bigserial PRIMARY KEY,
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN (
    'tab_blur', 'tab_focus', 'mouse_idle', 'paste_detected', 'devtools_open'
  )),
  event_data jsonb,
  client_timestamp timestamptz,
  server_timestamp timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX fairplay_telemetry_match_profile_idx
  ON fairplay_telemetry (match_id, profile_id);

-- ============================================================================
-- AUDIT & ADMIN
-- ============================================================================

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'admin', 'system')),
  actor_id uuid,
  action text NOT NULL,
  target_type text,
  target_id text,
  before jsonb,
  after jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, created_at DESC);
CREATE INDEX audit_logs_target_idx ON audit_logs (target_type, target_id);

CREATE TABLE admin_users (
  profile_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('support', 'moderator', 'admin', 'finance')),
  permissions jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
