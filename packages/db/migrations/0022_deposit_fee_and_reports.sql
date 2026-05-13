-- ============================================================================
-- Migration: 0022_deposit_fee_and_reports
-- Super-admin foundation: deposit-side platform fee, user-to-user reports,
-- ban list. Supports the /admin/super dashboard.
-- ============================================================================
--
-- Fee model change (supersedes PLAN.md §"Wallet & ledger"):
--   Previous spec: 15% platform fee deducted at MATCH SETTLEMENT
--     (escrow -> 85% opponent + 15% platform_revenue).
--   New spec:     15% platform fee charged at DEPOSIT.
--     User who wants $50 wallet credit is charged $57.50 by Stripe; on
--     payment_intent.succeeded the webhook posts two legs:
--       DR stripe_clearing 5750 / CR user_wallet     5000 (category 'deposit')
--       DR stripe_clearing    0 / CR platform_revenue 750 (category 'topup_fee')
--     At match settlement: 100% of escrow flows to the opponent's wallet
--     (matches.platform_fee_cents = 0, matches.opponent_payout_cents = fee_cents).
--   Rationale: simpler mental model for users ("you pay 15%, opponent gets
--   what you posted"), no per-match revenue plumbing, easier to comp users
--   via wallets.deposit_fee_rate_bps overrides.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Per-wallet deposit-fee rate. 1500 bps = 15.00%. Lets us comp users
--    or A/B different rates without code changes.
-- ----------------------------------------------------------------------------
ALTER TABLE wallets
  ADD COLUMN deposit_fee_rate_bps smallint NOT NULL DEFAULT 1500
    CHECK (deposit_fee_rate_bps BETWEEN 0 AND 10000);

COMMENT ON COLUMN wallets.deposit_fee_rate_bps IS
  'Platform fee charged on top of deposits, in basis points. 1500 = 15.00%.';

-- ----------------------------------------------------------------------------
-- 2. Extend ledger_entries.category to include the new deposit-side fee.
--    'platform_fee' is kept for legacy/match-settlement rows (now unused for
--    new rows, but historical data stays valid).
-- ----------------------------------------------------------------------------
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_category_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_category_check
  CHECK (category IN (
    'deposit', 'topup_fee', 'match_escrow', 'match_payout',
    'platform_fee', 'withdrawal', 'refund', 'reversal',
    'payout_hold', 'payout_release'
  ));

-- ----------------------------------------------------------------------------
-- 3. Topup intents — bridge between a user clicking "Add $50" and the
--    Stripe payment_intent that confirms (or fails) async via webhook.
--    Lets us reconcile gross_cents (what Stripe charged) vs. principal_cents
--    (what landed in the wallet) and surface failures in the admin view.
-- ----------------------------------------------------------------------------
CREATE TABLE topup_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  principal_cents integer NOT NULL CHECK (principal_cents > 0),
  fee_cents integer NOT NULL CHECK (fee_cents >= 0),
  gross_cents integer NOT NULL CHECK (gross_cents = principal_cents + fee_cents),
  currency char(3) NOT NULL DEFAULT 'USD',
  stripe_payment_intent_id text UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'succeeded', 'failed', 'refunded'
  )),
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  settled_at timestamptz
);
CREATE INDEX topup_intents_profile_idx
  ON topup_intents (profile_id, created_at DESC);
CREATE INDEX topup_intents_status_idx
  ON topup_intents (status, created_at DESC);

ALTER TABLE topup_intents ENABLE ROW LEVEL SECURITY;
-- Users see only their own topup attempts.
CREATE POLICY topup_intents_owner_read ON topup_intents
  FOR SELECT TO authenticated
  USING (profile_id = auth.uid());

-- ----------------------------------------------------------------------------
-- 4. User-to-user reports — distinct from fairplay_flags (anti-cheat).
--    user_reports captures behavioural complaints between users (harassment,
--    payment abuse, impersonation, etc.) and gates payouts: any user with an
--    open or under-investigation report has settlement payouts diverted to
--    'escrow' (held) until an admin resolves the report.
-- ----------------------------------------------------------------------------
CREATE TABLE user_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  reported_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  match_id uuid REFERENCES matches(id) ON DELETE SET NULL,
  reason text NOT NULL CHECK (reason IN (
    'harassment', 'cheating', 'impersonation', 'spam',
    'payment_abuse', 'sandbagging', 'other'
  )),
  details text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'investigating', 'resolved_valid', 'resolved_invalid', 'duplicate'
  )),
  resolved_by uuid REFERENCES profiles(id),
  resolution_note text,
  action_taken text CHECK (action_taken IN (
    'none', 'warning', 'ban', 'payout_forfeit', 'refund_issued'
  )),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  resolved_at timestamptz
);
CREATE INDEX user_reports_reported_status_idx
  ON user_reports (reported_id, status);
CREATE INDEX user_reports_open_queue_idx
  ON user_reports (status, created_at DESC)
  WHERE status IN ('open', 'investigating');

-- Helper used by settlement & withdrawal to decide whether to hold a payout.
CREATE OR REPLACE FUNCTION has_open_report(target uuid)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_reports
    WHERE reported_id = target AND status IN ('open', 'investigating')
  );
$$;

-- ----------------------------------------------------------------------------
-- 5. Bans — explicit list separate from soft signals so admins can flip a
--    single switch. Lift action is tracked so audits show ban history.
-- ----------------------------------------------------------------------------
CREATE TABLE user_bans (
  profile_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  banned_by uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  reason text NOT NULL,
  report_id uuid REFERENCES user_reports(id) ON DELETE SET NULL,
  banned_at timestamptz NOT NULL DEFAULT NOW(),
  lifted_at timestamptz,
  lifted_by uuid REFERENCES profiles(id),
  lifted_reason text
);
CREATE INDEX user_bans_active_idx ON user_bans (banned_at DESC)
  WHERE lifted_at IS NULL;

CREATE OR REPLACE FUNCTION is_banned(target uuid)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_bans
    WHERE profile_id = target AND lifted_at IS NULL
  );
$$;

-- ----------------------------------------------------------------------------
-- 6. RLS: reports & bans are admin-only. The /admin/super route uses the
--    service-role client (bypasses RLS); regular users see nothing.
-- ----------------------------------------------------------------------------
ALTER TABLE user_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_bans    ENABLE ROW LEVEL SECURITY;

-- A user can file a report (insert) but cannot read other rows.
CREATE POLICY user_reports_insert_own ON user_reports
  FOR INSERT TO authenticated
  WITH CHECK (reporter_id = auth.uid());

-- A user can see reports they filed (status visibility).
CREATE POLICY user_reports_select_own ON user_reports
  FOR SELECT TO authenticated
  USING (reporter_id = auth.uid());

-- No client-side ban table access at all.
-- (RLS denies by default once enabled.)
