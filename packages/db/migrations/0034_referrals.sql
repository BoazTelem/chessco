-- ============================================================================
-- Migration: 0034_referrals
-- Invite-friends referral system. Each profile gets an 8-char referral_code.
-- When an invitee verifies email, the referrer is granted 20 credits, capped
-- at 100 credits total per referrer (5 successful referrals). Mirrors the
-- credit_grants link-bonus pattern from 0031_credits_no_free_publishing.sql.
-- ============================================================================

-- ----- profiles.referral_code -----

ALTER TABLE profiles
  ADD COLUMN referral_code text UNIQUE;

UPDATE profiles
SET referral_code = lower(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
WHERE referral_code IS NULL;

ALTER TABLE profiles
  ALTER COLUMN referral_code SET NOT NULL;

-- ----- referrals -----

CREATE TABLE referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  referred_profile_id uuid NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  referral_code text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'credited', 'rejected')),
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  credited_at timestamptz,
  CHECK (referrer_profile_id <> referred_profile_id)
);
CREATE INDEX referrals_referrer_idx ON referrals (referrer_profile_id);

ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;

CREATE POLICY referrals_select_own ON referrals
  FOR SELECT USING (
    referrer_profile_id = auth.uid() OR referred_profile_id = auth.uid()
  );

-- ----- extend credit_ledger_entries.category + reference_type -----

ALTER TABLE credit_ledger_entries
  DROP CONSTRAINT credit_ledger_entries_category_check;
ALTER TABLE credit_ledger_entries
  ADD CONSTRAINT credit_ledger_entries_category_check
  CHECK (category IN (
    'link_bonus', 'challenge_reserve', 'challenge_refund',
    'challenge_consume', 'manual_adjustment', 'referral_bonus'
  ));

ALTER TABLE credit_ledger_entries
  DROP CONSTRAINT credit_ledger_entries_reference_type_check;
ALTER TABLE credit_ledger_entries
  ADD CONSTRAINT credit_ledger_entries_reference_type_check
  CHECK (reference_type IN (
    'external_account', 'challenge', 'match', 'manual', 'profile'
  ));

-- ----- extend credit_grants.source_type -----

ALTER TABLE credit_grants
  DROP CONSTRAINT credit_grants_source_type_check;
ALTER TABLE credit_grants
  ADD CONSTRAINT credit_grants_source_type_check
  CHECK (source_type IN ('external_account_link', 'manual', 'referral'));

-- ----- update handle_new_user trigger to set referral_code -----

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO profiles (id, email, referral_code)
  VALUES (
    NEW.id,
    NEW.email,
    lower(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO wallets (profile_id)
  VALUES (NEW.id)
  ON CONFLICT (profile_id) DO NOTHING;

  INSERT INTO ratings (profile_id)
  VALUES (NEW.id)
  ON CONFLICT (profile_id) DO NOTHING;

  RETURN NEW;
END;
$$;
