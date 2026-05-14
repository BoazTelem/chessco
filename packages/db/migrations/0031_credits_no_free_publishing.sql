-- ============================================================================
-- Migration: 0031_credits_no_free_publishing
-- Non-withdrawable publishing credits. Credits are reserved when a creator
-- publishes a credit-funded Practice challenge and are consumed only when a
-- game completes. They are not paid to opponents and cannot be withdrawn.
-- ============================================================================

ALTER TABLE wallets
  ADD COLUMN credit_available integer NOT NULL DEFAULT 0,
  ADD COLUMN credit_pending integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT wallets_credit_nonnegative
    CHECK (credit_available >= 0 AND credit_pending >= 0);

CREATE TABLE credit_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  direction char(1) NOT NULL CHECK (direction IN ('D', 'C')),
  amount integer NOT NULL CHECK (amount > 0),
  category text NOT NULL CHECK (category IN (
    'link_bonus', 'challenge_reserve', 'challenge_refund',
    'challenge_consume', 'manual_adjustment'
  )),
  reference_type text CHECK (reference_type IN (
    'external_account', 'challenge', 'match', 'manual'
  )),
  reference_id text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX credit_ledger_entries_profile_idx
  ON credit_ledger_entries (profile_id, created_at DESC);

CREATE TABLE credit_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('external_account_link', 'manual')),
  source_id text NOT NULL,
  amount integer NOT NULL CHECK (amount >= 0),
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (profile_id, source_type, source_id)
);
CREATE INDEX credit_grants_profile_idx
  ON credit_grants (profile_id, created_at DESC);

ALTER TABLE credit_ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_grants ENABLE ROW LEVEL SECURITY;

CREATE POLICY credit_ledger_entries_select_own ON credit_ledger_entries
  FOR SELECT USING (profile_id = auth.uid());

CREATE POLICY credit_grants_select_own ON credit_grants
  FOR SELECT USING (profile_id = auth.uid());

ALTER TABLE challenges
  ADD COLUMN funding_type text NOT NULL DEFAULT 'cash'
    CHECK (funding_type IN ('cash', 'credits')),
  ADD COLUMN credit_cost integer NOT NULL DEFAULT 0
    CHECK (credit_cost >= 0);

UPDATE challenges
SET funding_type = 'credits'
WHERE fee_cents = 0;

ALTER TABLE challenges
  ADD CONSTRAINT challenges_funding_shape
  CHECK (
    (funding_type = 'cash' AND fee_cents > 0 AND credit_cost = 0)
    OR
    (funding_type = 'credits' AND fee_cents = 0 AND credit_cost >= 0)
  );
