# WS-9 follow-ups (deferred from this turn)

WS-9 shipped the libraries, schema, and audit tests for §9 / §10 / §11 / §21 / §23 / §24. UI polish and live integrations stay for follow-up; this doc tracks them.

---

## §9 Glicko-2

- **Migrate**: `pnpm --filter @chessco/db drizzle:generate` to emit the `ratings_by_time_class` SQL, then apply.
- **Wire into match settlement**: at the end of `apps/realtime/src/settle.ts` (or the Inngest post-game function), load both players' current per-time-class rating, call `updatePair(white, black, result)`, write back. Insert a `rating_history` row per player.
- **Backfill**: a one-shot worker that walks completed `matches` and replays Glicko-2 from epoch so existing players get per-time-class ratings without losing history.

## §10 Trust score + tier gates

- **Daily recompute job**: Inngest cron that reads inputs (account age, paid match counts, refunds, fairplay flags, KYC), calls `computeTrustScore`, persists `score + tier` onto `ratings`.
- **Wire `tierGates(tier)` into**:
  - `POST /api/practice/challenges` — reject when `canCreatePaidChallenges = false` or fee > `maxChallengeFeeCents`.
  - `POST /api/sparring/profile` — reject `opted_in = true` when `canListInSparring = false`.
  - `/account/wallet` — use the actual `tier` instead of the hard-coded `'new'`.
- **Admin override**: `/admin/super/users` should expose a "set trust tier" action that writes to audit_logs and bypasses recompute for 24h.

## §11 Refund queue

- **Filing endpoint**: `POST /api/refunds` that calls `resolveRefundAutomatically` and either auto-approves (writing a refund `ledger_entries` transaction via `buildRefundLines`) or marks `under_review`.
- **Admin queue**: `/admin/refunds` page that lists `status='under_review'`, surfaces the evidence JSON, and offers Approve/Deny actions.
- **3-denied-in-90-days suspension**: middleware on the filing endpoint that counts `status='denied'` rows in the last 90 days and rejects further filings with a 429.

## §21 Email triggers

- Hook `sendEmail({ template: 'prep_report_ready', ... })` into the prep report status-→ready transition.
- Hook `'challenge_accepted'` into the accept endpoint.
- Hook `'match_settled'` into the settle path.
- Hook `'refund_decided'` into the refund auto-approve + admin approve/deny paths.
- Hook `'fairplay_action'` when an admin records an action on the fairplay queue (lands with WS-11).
- Operator wires `RESEND_API_KEY` + `EMAIL_FROM`.

## §23 Monitoring

- **Sentry**: install `@sentry/nextjs` at apps/web, run the wizard or set `SENTRY_DSN`, restart. `initSentry()` becomes a no-op stub.
- **PostHog**: set `POSTHOG_API_KEY`; wire `captureEvent` calls into:
  - signup flow → `signup_completed`
  - OAuth callback → `external_account_linked`
  - /prepare entry → `prep_report_started`, /reports/[id] view → `prep_report_viewed`
  - /api/practice/challenges → `challenge_published`
  - /api/practice/challenges/[id]/accept → `challenge_accepted`
  - settle path → `match_completed`
  - /api/refunds → `refund_filed`
  - withdrawal (when billing unparks) → `withdrawal_initiated`
  - subscription start → `subscription_started`
- **Metabase**: connect to the Supabase read replica; build dashboards from spec §23: MRR (deferred until billing), DAU/WAU/MAU, fairplay rate, refund grant rate, prep reports per day.

## §24 GDPR

- **`/account/privacy` page**: existing route already references privacy; add Export + Delete CTAs there pointing at the new endpoints.
- **30-day purge worker**: Inngest cron that hard-deletes `profiles` rows where `deleted_at < NOW() - INTERVAL '30 days'`. Must cascade via existing FK `ON DELETE CASCADE` chains.
- **AI training opt-in**: add `ai_training_opt_in` boolean to profiles + enforce in the LLM pipeline (skip a player's games from any training dataset if false). Defaults to false.
