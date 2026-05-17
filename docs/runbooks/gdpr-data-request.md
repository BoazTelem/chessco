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

2. Direct the user to `/account/privacy` → "Delete my account" (calls `POST /api/account/delete`). The endpoint nullifies all PII synchronously (display_name, avatar_url, bio, country, city, date_of_birth, chess_title, last_seen_at, stripe_account_id, stripe_customer_id, kyc_status) and rewrites email/username/referral_code to sentinels. The row stays so financial/audit references survive.

3. If the user cannot self-serve, run from admin (match the route's behavior exactly — keep all nullified columns in sync):

   UPDATE profiles
   SET deleted_at = NOW(),
   display_name = NULL,
   avatar_url = NULL,
   bio = NULL,
   country = NULL,
   city = NULL,
   date_of_birth = NULL,
   chess_title = NULL,
   last_seen_at = NULL,
   stripe_account_id = NULL,
   stripe_customer_id = NULL,
   kyc_status = 'none',
   email = 'deleted-' || id::text || '@chessco.local',
   username = 'deleted-' || left(id::text, 8),
   referral_code = 'deleted-' || left(id::text, 8),
   marketing_consent = false,
   updated_at = NOW()
   WHERE id = '...';
   INSERT INTO audit_logs (actor_type, actor_id, action, target_type, target_id, reason)
   VALUES ('admin', '<admin_id>', 'account.delete', 'profile', '...', 'gdpr_art_17');

4. Financial records (`ledger_entries`, `matches`) and `ban_actions` are retained against the soft-deleted row. There is no hard-delete worker on the soft-delete path — the row remains queryable for disputes and audit. `ban_actions.profile_id` is `ON DELETE RESTRICT`, so any future hard-delete will fail until bans are reversed via `POST /api/fairplay/[id]/reverse`. Inform the user that PII has been erased but transactional references are retained.

## Verify

- The user received a confirmation email.
- Audit log entry exists.
- `profiles.deleted_at` is non-null (erasure path) or export was delivered (access path).

## Escalate

- The user disputes the financial-record retention period: route to legal; do not negotiate the window unilaterally.
- The user is in a non-EU/UK/CH jurisdiction with stricter rules (e.g. California CCPA): apply equivalent treatment by default.
