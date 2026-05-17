# Runbook — account deletion

**When** a user requested account deletion via `/account/privacy` or email.

**Goal** the user's identifiable data is erased synchronously; financial and moderation references are retained against the soft-deleted row per spec §24.

## Steps — soft-delete (one shot, no deferred work)

1. User self-serves via `POST /api/account/delete` (body: `{ "confirm": "DELETE" }`). The endpoint, in a single transaction:
   - sets `profiles.deleted_at = NOW()`
   - **nulls all PII**: display_name, avatar_url, bio, country, city, date_of_birth, chess_title, last_seen_at, stripe_account_id, stripe_customer_id
   - sets kyc_status = 'none', marketing_consent = false
   - rewrites email → `deleted-{id}@chessco.local`, username + referral_code → `deleted-{first-8-of-id}` (frees the unique indexes; original email/handle can be re-registered)
   - writes an `audit_logs` row

   Response: `{ deleted: true, deleted_at, pii_cleared: true }`. There is no 30-day deferred purge — PII is gone on return.

2. If the user can't self-serve, follow [gdpr-data-request.md](./gdpr-data-request.md) "Article 17" steps.

## Retained against the soft-deleted row

These are NOT purged and remain queryable for disputes / audit / regulatory:

- `matches`, `ledger_entries`, `refund_requests` (financial)
- `ban_actions` (moderation history; FK is `ON DELETE RESTRICT`)
- `audit_logs` rows where the user is actor or target
- `external_accounts` (linked platform handles — could carry the user's lichess/chess.com id; consider broadening the route's null sweep if your legal review requires it)

## Verify

- `SELECT display_name, country, date_of_birth, email FROM profiles WHERE id = '...'` returns NULLs / sentinel email.
- A re-registered email by the same user does not conflict.
- An `audit_logs` row with action='account.delete' exists.

## Escalate

- User asks for hard-delete of the row itself (not just PII): blocked by `ban_actions.profile_id ON DELETE RESTRICT` and `matches.creator_id ON DELETE RESTRICT`. Reverse any open bans via `POST /api/fairplay/[id]/reverse`, then escalate to legal — hard-deleting transactional rows is a policy decision, not a runbook step.
- Mass-deletion request from an admin: log it, double-check, never automate.
