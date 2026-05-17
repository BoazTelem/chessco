# Runbook — incident response

**When** production is degraded or down: Vercel 5xx spike, realtime server errors, Cloud SQL latency, payment failures, or a Sentry alert fires.

**Goal** mitigate within 15 minutes; root-cause and write postmortem within 5 business days.

## Severity ladder

| Severity  | Examples                                                        | Response                                            |
| --------- | --------------------------------------------------------------- | --------------------------------------------------- |
| **SEV-1** | `/` returning 5xx; live games cannot be played; payments stuck  | Page on-call immediately. 15-min mitigation target. |
| **SEV-2** | One feature broken (e.g. /scout slow); fairplay queue backed up | Same-day mitigation; comms in #ops Slack.           |
| **SEV-3** | Cosmetic / metrics drift / single-user issue                    | Next business day.                                  |

## Steps

1. **Confirm**. Open Sentry → check error rate trend. Open Vercel → check function durations. Open the status page (when shipped).

2. **Mitigate before diagnosing**:
   - For deploy-correlated regressions: revert the latest Vercel deploy from the dashboard.
   - For game-server crashes: `fly apps restart` the realtime app.
   - For DB latency: check `pnpm ingest:status` + Supabase / Cloud SQL dashboards. Failover via `database-restore.md` if needed.

3. **Communicate**. Post a status update if SEV-1 or SEV-2. Update every 15 min until resolved.

4. **Diagnose**. Look at the most-recent commits, Sentry stack traces, audit_logs entries.

5. **Resolve**. Roll forward a fix or accept the revert. Document the resolution in a postmortem.

## Verify

- Error rate is back to baseline in Sentry.
- A representative request succeeds: signup → /scout → /prepare → /practice → /account/wallet.
- Comms posted.

## Escalate

- Stripe / Paddle outage (once billing lands): wait it out, don't roll back our side; their status page is canonical.
- Cloud SQL regional outage: realtime server cannot persist; halt new game starts via a feature flag (Inngest controls), let in-progress games continue from process memory until 60s grace expires.
- Suspected breach: also follow [account-takeover.md](./account-takeover.md) for any affected accounts, rotate any compromised secrets, notify affected users within 72h (GDPR).

## After

- Postmortem doc in `docs/postmortems/{YYYY-MM-DD}-{slug}.md`. Format: timeline, root cause, what went well, what didn't, action items.
