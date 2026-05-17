# Runbook — account deletion

**When** a user requested account deletion via `/account/privacy` or email, OR a 30-day purge needs to run.

**Goal** the user's identifiable data is removed within 30 days; financial records retained per spec §24 retention policy.

## Steps — initial soft-delete

1. User self-serves via `POST /api/account/delete` (body: `{ "confirm": "DELETE" }`). The endpoint:
   - sets `profiles.deleted_at = NOW()`
   - rewrites display_name, avatar_url, bio, email → null/sentinel
   - writes an audit_log row

2. If the user can't self-serve, follow [gdpr-data-request.md](./gdpr-data-request.md) "Article 17" steps.

## Steps — 30-day hard-purge (cron)

Once landed, runs daily and deletes everything older than 30 days:

    DELETE FROM profiles WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days';

Cascading FKs handle `external_accounts`, `players` (set null), `prep_reports`, `challenges`, `matches` (restrict — keep money-related rows), `ledger_entries` (no FK on profile to begin with).

The Inngest function lives at (to be created) `apps/workers/src/account-purge/run.ts`. Until then, run manually monthly.

## Verify

- `SELECT count(*) FROM profiles WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days'` returns 0 after the purge.
- A re-registered email by the same user does not conflict with the rewritten sentinel.

## Escalate

- A match-related row prevents profile delete due to `ON DELETE RESTRICT`: leave the profile soft-deleted (already PII-cleared); revisit in 90 days when match disputes are resolved.
- Mass-deletion request from an admin: log it, double-check, never automate.
