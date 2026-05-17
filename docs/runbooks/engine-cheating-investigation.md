# Runbook — engine cheating investigation

**When** the fairplay queue surfaces a flag with `severity ≥ 4` OR a player reports an opponent.

**Goal** a confirmed or dismissed outcome within 72h (spec §12 SLA). False-positive rate <2% on the labeled eval set.

## Steps

1. Open `/admin/fairplay` (once shipped — WS-11). Until then, query directly:

   SELECT id, profile_id, match_id, flag_type, severity, signals, created_at
   FROM fairplay_flags
   WHERE outcome = 'pending'
   ORDER BY severity DESC, created_at ASC;

2. For each flag, gather corroborating evidence:
   - Engine correlation rerun at depths 12 / 18 / 25 (WS-11 worker; manual run via `apps/workers/src/stockfish/backfill.ts --platform … --handle …` until then).
   - Move-time-vs-complexity histogram.
   - Telemetry signals from `fairplay_telemetry` (tab_blur / paste_detected / devtools_open within the match window).
   - Player history: prior flags, prior bans, rating trajectory, account age.

3. Decision:
   - **Confirm** if engine-match rate exceeds the rating-appropriate baseline by >2σ AND at least one corroborating signal (telemetry or move-time).
   - **Dismiss** if engine match is within baseline OR corroborating signals are absent.
   - **Defer** only if rerun is still computing or telemetry is missing; not a final state.

4. If confirmed, apply the action ladder (spec §12):
   - severity 1: warning, logged. `ban_actions.severity = 1`.
   - severity 2: paid-play suspended 7 days.
   - severity 3: paid-play suspended 30 days.
   - severity 4: paid-play permanently suspended.
   - severity 5: full account suspended 30 days.
   - severity 6: permanent ban + forfeit pending earnings to platform_revenue via `buildRefundLines`-like reversal.

5. Notify the affected player via `sendEmail({ template: 'fairplay_action', ... })`. Set `appealUrl` to `/account/fairplay/appeal/{action_id}`.

6. Record the action: `INSERT INTO ban_actions (...)` + audit log row.

## Verify

- `fairplay_flags.outcome` is `confirmed` or `dismissed`.
- `ban_actions` row matches the severity applied.
- The user received the email (Resend logs).
- If severity ≥ 4 and the user had pending wallet balance, ledger reversal posted.

## Escalate

- Disputed by the player via appeal: route to a senior reviewer; do not auto-respond.
- Multiple flags on the same account → consider permanent ban (severity 6).
- Pattern flag (many flags across a session/IP) → consider IP block + Cloudflare rule.
