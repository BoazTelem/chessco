-- ============================================================================
-- Migration: 0039_credits_only_pivot
--
-- Pivot Chessco from "paid sparring marketplace" (P2P USD with platform fee)
-- to subscription + internal credits only. Credits are non-monetary,
-- non-withdrawable, non-transferable promotional service tokens.
--
-- This migration is the *foundation* of that pivot (Phase 0 in the plan at
-- C:\Users\boaz\.claude\plans\i-was-thinking-about-noble-glade.md). It does
-- four things:
--
--   1. Extends credit_ledger_entries.category and credit_grants.source_type to
--      cover the new credit flows (practice_reward, subscription_grant,
--      cycle_expiry) so application code can write them without violating
--      CHECK constraints.
--
--   2. Adds credit_ledger_entries.counterpart_profile_id so the rolling
--      per-pair abuse cap on practice rewards can be enforced with a single
--      index scan instead of a join through matches.
--
--   3. Tightens challenges_funding_shape so any challenge created AFTER this
--      migration must be funded with credits (no cash, no fee_cents) and
--      either free (credit_cost = 0) or paid at exactly 1 credit per game
--      (credit_cost = games_requested). Cash and arbitrary-stake legacy rows
--      are grandfathered via a created_at cutoff so settlement can still
--      finish for in-flight matches.
--
--   4. Adds an index supporting daily and per-pair abuse-cap queries against
--      credit_ledger_entries (Phase 0 ships those caps in application code).
-- ============================================================================

-- ----- credit_ledger_entries.category: add practice_reward, subscription_grant, cycle_expiry -----

ALTER TABLE credit_ledger_entries
  DROP CONSTRAINT credit_ledger_entries_category_check;

ALTER TABLE credit_ledger_entries
  ADD CONSTRAINT credit_ledger_entries_category_check
  CHECK (category IN (
    'link_bonus', 'challenge_reserve', 'challenge_refund',
    'challenge_consume', 'manual_adjustment', 'referral_bonus',
    'prep_leak_reveal',
    'practice_reward', 'subscription_grant', 'cycle_expiry'
  ));

-- ----- credit_grants.source_type: add practice_reward, subscription, signup_bonus -----
-- subscription + signup_bonus aren't used until Phase 1, but adding them here
-- avoids a second migration for that small change.

ALTER TABLE credit_grants
  DROP CONSTRAINT credit_grants_source_type_check;

ALTER TABLE credit_grants
  ADD CONSTRAINT credit_grants_source_type_check
  CHECK (source_type IN (
    'external_account_link', 'manual', 'referral',
    'practice_reward', 'subscription', 'signup_bonus'
  ));

-- ----- credit_ledger_entries.counterpart_profile_id -----
-- Denormalized counterpart for per-pair rolling caps on practice_reward
-- entries. Nullable — only populated for entries where the concept of a
-- counterpart makes sense (currently just practice_reward).

ALTER TABLE credit_ledger_entries
  ADD COLUMN counterpart_profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL;

-- Supports the per-pair cap query:
--   SELECT COALESCE(SUM(amount), 0)
--   FROM credit_ledger_entries
--   WHERE profile_id = $1
--     AND counterpart_profile_id = $2
--     AND category = 'practice_reward'
--     AND created_at >= NOW() - INTERVAL '7 days';
CREATE INDEX credit_ledger_entries_practice_reward_pair_idx
  ON credit_ledger_entries (profile_id, counterpart_profile_id, created_at DESC)
  WHERE category = 'practice_reward';

-- Supports the daily-cap query:
--   SELECT COALESCE(SUM(amount), 0)
--   FROM credit_ledger_entries
--   WHERE profile_id = $1
--     AND category = 'practice_reward'
--     AND created_at >= NOW() - INTERVAL '24 hours';
CREATE INDEX credit_ledger_entries_practice_reward_daily_idx
  ON credit_ledger_entries (profile_id, created_at DESC)
  WHERE category = 'practice_reward';

-- ----- challenges_funding_shape: lock new rows to credits-only, 1-credit-per-game -----
--
-- Legacy rows (created before the pivot cutoff) keep the old shape so any
-- in-flight matches can still settle. New rows must be credit-funded and
-- either free (credit_cost = 0) or paid at credit_cost = games_requested
-- (i.e. exactly 1 credit per game — no arbitrary stakes).

ALTER TABLE challenges
  DROP CONSTRAINT IF EXISTS challenges_funding_shape;

ALTER TABLE challenges
  ADD CONSTRAINT challenges_funding_shape
  CHECK (
    -- Legacy rows: pre-pivot shape (cash OR credits with old credit_cost rules)
    created_at < TIMESTAMPTZ '2026-05-16 00:00:00+00'
    OR
    -- New rows: credits-only, fixed 1-credit-per-game or free
    (
      funding_type = 'credits'
      AND fee_cents = 0
      AND (credit_cost = 0 OR credit_cost = games_requested)
    )
  );
