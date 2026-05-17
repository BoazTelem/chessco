# Runbook — account takeover

**When** a user reports unauthorized access, or you observe unusual session activity (logins from a new country immediately followed by withdrawal attempts, mass challenge creation, etc.).

**Goal** restore control to the legitimate owner within 1 hour; protect any wallet balance.

## Steps

1.  Immediately freeze the account:

        UPDATE profiles SET deleted_at = NULL  -- safety: don't soft-delete here
        WHERE id = '...';
        -- Use Supabase Auth admin to disable the user:
        -- supabase admin users disable <user_id>

    Disable in Supabase Auth so all live sessions are invalidated.

2.  Lock the wallet so no withdrawals can be initiated:

        UPDATE wallets SET pending_cents = available_cents, available_cents = 0
        WHERE profile_id = '...';

    This moves all available balance to pending; the withdrawal endpoint (once billing lands) rejects withdrawals from accounts whose pending exceeds threshold.

3.  Cancel any open challenges + invitations:

    UPDATE challenges SET status = 'cancelled'
    WHERE creator_id = '...' AND status = 'open';
    UPDATE challenge_invitations SET status = 'withdrawn'
    WHERE inviter_id = '...' AND status = 'pending';

4.  Audit recent activity:

    SELECT _ FROM audit_logs WHERE actor_id = '...' ORDER BY created_at DESC LIMIT 50;
    SELECT _ FROM ledger_entries WHERE account_id = '...' ORDER BY created_at DESC LIMIT 50;

5.  Verify the reporter's identity. Require:
    - email confirmation from the account's email of record, OR
    - the linked Lichess/Chess.com handle's bio updated with a verification token.

6.  Once verified, re-enable + rotate credentials:
    - Force password reset via Supabase Auth admin.
    - Revoke linked OAuth tokens for chess.com / Lichess (the user re-links).
    - Re-enable the account.
    - Restore wallet balance (pending → available).

## Verify

- The legitimate owner can log in via password reset.
- No new sessions exist for the prior tokens.
- No new ledger entries since the freeze.

## Escalate

- Money was withdrawn before freeze: open a Stripe / Paddle dispute (when billing live); recover via chargeback path.
- Suspected bulk takeover (multiple accounts hit at once): rotate any shared secrets; check audit_logs for the same IP across freezes.
