# Runbook — GDPR data request

**When** a user emails support@chessco.org (or equivalent) invoking GDPR Article 15 (access) or Article 17 (erasure). EU + UK + Swiss residents qualify; other jurisdictions are handled best-effort.

**Goal** acknowledge within 72h; complete within 30 days (Art. 12 §3).

## Steps — Article 15 (access)

1. Verify identity. Reply from the email of record; require confirmation from that address before proceeding.

2. Once verified, direct the user to `/account` → "Export my data" (calls `GET /api/account/export`). The endpoint produces a JSON bundle with 8 tables (profile, external_accounts, ratings, prefs, challenges, matches, ledger_entries, refund_requests).

3. If the user cannot self-serve (e.g. account locked):

   curl -X GET "$BASE/api/account/export" \
    -H "cookie: $ADMIN_IMPERSONATION_COOKIE"

   # Requires admin impersonation — see admin/super tooling.

4. Reply with the JSON file attached + a short text explanation. Note the 1-per-24h rate limit on the endpoint.

## Steps — Article 17 (erasure)

1. Verify identity (same as Article 15).

2. Direct the user to `/account/privacy` → "Delete my account" (calls `POST /api/account/delete`). Soft-deletes; 30-day purge worker hard-deletes.

3. If the user cannot self-serve, run from admin:

   UPDATE profiles
   SET deleted_at = NOW(),
   display_name = NULL,
   avatar_url = NULL,
   bio = NULL,
   email = 'deleted-' || id::text || '@chessco.local',
   marketing_consent = false
   WHERE id = '...';
   INSERT INTO audit_logs (actor_type, actor_id, action, target_table, target_id, metadata)
   VALUES ('admin', '<admin_id>', 'account.delete', 'profiles', '...', '{"via":"manual","reason":"gdpr_art_17"}'::jsonb);

4. Financial records (`ledger_entries`, `matches`) are retained for 30 days post-deletion per spec §24, then purged by the cron. Inform the user of the retention window.

## Verify

- The user received a confirmation email.
- Audit log entry exists.
- `profiles.deleted_at` is non-null (erasure path) or export was delivered (access path).

## Escalate

- The user disputes the financial-record retention period: route to legal; do not negotiate the window unilaterally.
- The user is in a non-EU/UK/CH jurisdiction with stricter rules (e.g. California CCPA): apply equivalent treatment by default.
