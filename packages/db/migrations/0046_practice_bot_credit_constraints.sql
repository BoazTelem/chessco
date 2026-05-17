-- ============================================================================
-- Practice bot credit-mode ledger constraint extension
-- ============================================================================
-- Phase 6C writes practice-bot win/loss entries to credit_ledger_entries.
-- Keep the database CHECK constraints in sync with the Drizzle schema before
-- the new settlement route can insert those rows.

ALTER TABLE credit_ledger_entries
  DROP CONSTRAINT IF EXISTS credit_ledger_entries_category_check;

ALTER TABLE credit_ledger_entries
  ADD CONSTRAINT credit_ledger_entries_category_check
  CHECK (category IN (
    'link_bonus', 'challenge_reserve', 'challenge_refund',
    'challenge_consume', 'manual_adjustment', 'referral_bonus',
    'prep_leak_reveal',
    'practice_reward', 'practice_bot_win', 'practice_bot_loss',
    'subscription_grant', 'cycle_expiry'
  ));

ALTER TABLE credit_ledger_entries
  DROP CONSTRAINT IF EXISTS credit_ledger_entries_reference_type_check;

ALTER TABLE credit_ledger_entries
  ADD CONSTRAINT credit_ledger_entries_reference_type_check
  CHECK (reference_type IN (
    'external_account', 'challenge', 'match', 'manual', 'profile',
    'prep_leak_unlock', 'practice_bot_game'
  ));
