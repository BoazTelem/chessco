-- ============================================================================
-- Personalized Leaks — unlock quota + prep_reports extension
-- ============================================================================
-- Feature: /prepare/[platform]/[handle] "Personalized leaks" card.
-- First leak revealed per (user, platform, handle) is free; additional reveals
-- cost 1 credit. Surprise lines stay free and never write to this table.
--
-- This migration:
--   1. Creates prep_leak_unlocks with idempotency + free-quota partial unique
--      index + RLS (users read their own rows; writes via service role).
--   2. Extends prep_reports with target_platform / target_handle_normalized /
--      leaks_json / error_text and rewrites the status CHECK to accept
--      'data_pending'. Adds a partial unique active-report index per opponent.
--   3. Extends credit_ledger_entries category/reference_type CHECK constraints
--      with 'prep_leak_reveal' / 'prep_leak_unlock'.
-- ============================================================================

-- ----- prep_leak_unlocks -----

CREATE TABLE prep_leak_unlocks (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id               uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  target_platform          text NOT NULL CHECK (target_platform IN ('lichess', 'chess.com')),
  target_handle_normalized text NOT NULL,
  leak_fingerprint         text NOT NULL,
  prep_report_id           uuid REFERENCES prep_reports(id) ON DELETE SET NULL,
  cost_credits             integer NOT NULL CHECK (cost_credits IN (0, 1)),
  unlocked_at              timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (profile_id, target_platform, target_handle_normalized, leak_fingerprint)
);

-- At most one free (cost=0) reveal per user+opponent. Enforced at the DB so a
-- race between two simultaneous reveals degrades safely (one wins free, the
-- other gets cost=1 on retry).
CREATE UNIQUE INDEX prep_leak_unlocks_one_free_per_opp
  ON prep_leak_unlocks (profile_id, target_platform, target_handle_normalized)
  WHERE cost_credits = 0;

CREATE INDEX prep_leak_unlocks_user_opp_idx
  ON prep_leak_unlocks (profile_id, target_platform, target_handle_normalized, unlocked_at DESC);

ALTER TABLE prep_leak_unlocks ENABLE ROW LEVEL SECURITY;

CREATE POLICY prep_leak_unlocks_select_own
  ON prep_leak_unlocks FOR SELECT
  USING (profile_id = auth.uid());

-- ----- prep_reports extension -----

ALTER TABLE prep_reports
  ADD COLUMN target_platform          text,
  ADD COLUMN target_handle_normalized text,
  ADD COLUMN leaks_json               jsonb,
  ADD COLUMN error_text               text;

ALTER TABLE prep_reports
  ADD CONSTRAINT prep_reports_target_platform_check
  CHECK (target_platform IS NULL OR target_platform IN ('lichess', 'chess.com'));

-- Rewrite status CHECK to permit 'data_pending'. 'building' is retained for
-- backward compatibility with any pre-feature rows.
ALTER TABLE prep_reports
  DROP CONSTRAINT prep_reports_status_check;

ALTER TABLE prep_reports
  ADD CONSTRAINT prep_reports_status_check
  CHECK (status IN ('pending', 'building', 'data_pending', 'ready', 'failed'));

-- Idempotent active report per (requested_by, platform, handle). Partial so
-- existing pre-feature rows with NULL target_* don't collide.
CREATE UNIQUE INDEX prep_reports_active_per_opp
  ON prep_reports (requested_by, target_platform, target_handle_normalized)
  WHERE target_platform IS NOT NULL
    AND target_handle_normalized IS NOT NULL;

-- ----- credit_ledger_entries category + reference_type -----

ALTER TABLE credit_ledger_entries
  DROP CONSTRAINT credit_ledger_entries_category_check;

ALTER TABLE credit_ledger_entries
  ADD CONSTRAINT credit_ledger_entries_category_check
  CHECK (category IN (
    'link_bonus', 'challenge_reserve', 'challenge_refund',
    'challenge_consume', 'manual_adjustment', 'referral_bonus',
    'prep_leak_reveal'
  ));

ALTER TABLE credit_ledger_entries
  DROP CONSTRAINT credit_ledger_entries_reference_type_check;

ALTER TABLE credit_ledger_entries
  ADD CONSTRAINT credit_ledger_entries_reference_type_check
  CHECK (reference_type IN (
    'external_account', 'challenge', 'match', 'manual', 'profile',
    'prep_leak_unlock'
  ));
