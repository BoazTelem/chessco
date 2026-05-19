# Incident — Lichess blocked our static IP (2026-05-18)

## Summary

For ~4 days (2026-05-14 → 2026-05-18) two Lichess workers ran simultaneously from the office static IP 62.0.122.38, anonymous, with a User-Agent that pointed to a non-resolving domain. Lichess silently null-routed the IP at TCP 443. Personal Lichess access from the office was also blocked. The IP was restored ~2 hours after a contrite appeal email to `contact@lichess.org`.

Separately, while debugging the user-visible symptom (`/prepare/lichess/DrBozi` stuck on "Loading cached games"), we discovered the `/api/prepare/games` route was timing out at 60s for any chess.com handle with ≥500 games in the corpus — a corpus-growth bug unrelated to the IP block but affecting every user, not just the blocked one.

## Timeline

| When              | Event                                                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-12        | Decision recorded: bulk Lichess work runs locally on the office machine to gather runtime numbers ([memory: lichess-dump-compute-decision])                                         |
| 2026-05-14 15:25  | `lichess-crawl` worker started locally (PID 89708/86828): anonymous, 1500ms inner gap, single Node process                                                                          |
| 2026-05-17 17:11  | `fast-lane-lichess` worker started locally (PID 92528/101440) alongside the crawler — second concurrent Node process from the same IP                                               |
| 2026-05-18 ~10am  | `database.lichess.org` continues to work, but TCP to `lichess.org` silently dropped from this IP. Web UI users in production unaffected (Vercel IPs); the user's home access broken |
| 2026-05-18 18:00  | Block confirmed: ICMP through, TCP 443 silently dropped, cellular access works fine                                                                                                 |
| 2026-05-18 18:15  | Workers stopped; User-Agent corrected; appeal email drafted                                                                                                                         |
| 2026-05-18 19:30  | Appeal sent from `btelem@gmail.com` to `contact@lichess.org`                                                                                                                        |
| 2026-05-18 ~21:30 | Lichess restored access. Total downtime: ~12 hours of background work, ~3 hours of personal access                                                                                  |

## Root causes

**Per-process rate gate.** `apps/workers/src/lib/lichess-api.ts` uses a module-scope `let lastRequestAt` plus a promise-chain mutex. That serialises calls _within one Node process_. Two Node processes from the same IP each thought they were politely paced at 1.5s/req — but Lichess sees one IP, so the effective gap was ~750ms, double the anon ceiling for `/api/games/user/`.

**No `LICHESS_API_TOKEN`.** Authenticated tier raises the per-IP budget ~6× (250ms inner gap vs 1500ms) and identifies the operator. Anonymous bulk from a residential IP is the profile Lichess's abuse system is built to flag.

**Broken `User-Agent` contact URL.** The header pointed to `https://chessco.org` which was correct as a domain but lacked a contact email. A mid-incident edit briefly changed it to `https://chessco.app` which doesn't resolve. Either form denies Lichess ops a path to reach a human if the worker misbehaves — a bad-faith signal.

**Bulk-scraping pattern from a residential IP.** Lichess explicitly recommends consuming the monthly database dumps from `database.lichess.org` for bulk work. The per-handle `/api/games/user/` endpoint is for thin per-request queries. Running it against thousands of handles continuously from a single residential IP is what we did.

## What was fixed in this session

| Change                                                                                                                                                                         | File / location                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Workers killed (lichess-crawl + fast-lane-lichess)                                                                                                                             | PIDs 89708, 86828, 92528, 101440                                                             |
| User-Agent now `chessco-worker/0.1 (+https://chessco.org; contact: btelem@gmail.com)`                                                                                          | [apps/workers/src/lib/lichess-api.ts:19](../apps/workers/src/lib/lichess-api.ts#L19)         |
| `/api/prepare/games` DEFAULT_LIMIT capped at 200 — the JOIN at 500 was blowing Cloud SQL's 10GB `temp_file_limit` and returning silent 502s for all prolific chess.com handles | [apps/web/app/api/prepare/games/route.ts:24](../apps/web/app/api/prepare/games/route.ts#L24) |
| Appeal email sent + Lichess unblock confirmed                                                                                                                                  | n/a                                                                                          |

## Policy decision

**All bulk scrapers run from Cloud Run, never from the office.** No exceptions for "first run to gather numbers" or "smoke test against prod" or "just this once." The 2026-05-12 "local-first" decision in [memory: lichess-dump-compute-decision] is hereby reversed. Reasons:

1. Office IP is static. A repeat block does not self-heal — and a second block after the first appeal will be much harder to reverse. We've already used our one mulligan.
2. The office IP is also the user's personal Lichess access. Burning it again costs us a real human user, not just throughput.
3. Cost is trivial: per [docs/CLOUD-RUN-CRAWLERS.md](./CLOUD-RUN-CRAWLERS.md), the full active backfill runs ~$5/day total across 6 jobs and ~<$1/day at steady state.
4. The Cloud Run runbook is already written; the images already build; the watchdog is already in the Inngest serve process. The only missing piece is deployment.

### What "bulk scraper" means here

Anything that hits a public chess API for more than ~20 requests/hour sustained, OR runs unattended for more than 10 minutes, OR loops through a list of handles. Concretely:

- `apps/workers/src/lichess-crawl/` — Cloud Run only
- `apps/workers/src/chesscom-crawl/` — Cloud Run only
- `apps/workers/src/features/fast-lane-lichess.ts` — Cloud Run only
- `apps/workers/src/external-pgn/lichess-broadcasts/` — Inngest cron, single instance, fine to leave on the office Inngest serve for now since volume is low; consider Cloud Run when it grows
- Future ChessBase scraper — Cloud Run only

What's still fine locally:

- Smoke tests with `--max-items 1` or `--limit 10` for a few minutes of dev work
- One-off scripts hitting `database.lichess.org` (dumps host, separate from `lichess.org` API)
- `/prepare/[platform]/[handle]` page during dev (single user, per-page request)
- Inngest dev server (the cron functions themselves dispatch to Cloud Run jobs)

## Action items

- [ ] Deploy the six Cloud Run jobs per [CLOUD-RUN-CRAWLERS.md](./CLOUD-RUN-CRAWLERS.md) §"One-time GCP setup"
- [ ] Mint two `LICHESS_API_TOKEN`s (one per Lichess region) at https://lichess.org/account/oauth/token/create
- [ ] Set the `CHESSCOM_CRAWL_*` and `LICHESS_CRAWL_*` env vars on the Inngest serve process so the watchdog can dispatch
- [ ] Delete or archive `apps/workers/scripts/lichess-crawl-loop.ps1` and `chesscom-crawl-loop.ps1` so future-you can't accidentally rerun them
- [ ] Drop the positions JOIN from `/api/prepare/games` in a follow-up — reconstruct FENs client-side via chess.js (already imported). Cuts response size ~50% and removes the per-row positions lookup. The DEFAULT_LIMIT=200 cap is a stopgap; corpus growth will catch up again
- [ ] Add a CI check that fails if anyone reintroduces a "run locally" path in the crawl runbooks

## Update from Lichess (2026-05-18, post-appeal)

Thomas at Lichess replied to the appeal a few hours after it was sent:

> The Lichess API isn't designed for bulk user enumeration and uses rate limiting to prevent it. Instead, please use the game database dumps at https://database.lichess.org/ like you identified. The IP block affecting your personal ability to access Lichess will automatically expire.

Two operational facts to internalise:

1. **The earlier unblock was timer-based auto-expiry, not a manual decision.** Lichess doesn't review appeals before unblock; they just confirm the path forward.
2. **The whole per-handle `/api/games/user/` enumeration approach is forbidden, regardless of pacing, token, or egress IP.** Moving the same loop to Cloud Run with two regional tokens would have ended up blocked too. The structural fix is to use the dumps channel Lichess intends for bulk.

### What this triggered, in addition to the actions above

The Lichess per-handle crawler infrastructure was fully retired on 2026-05-18:

- Deleted: `apps/workers/src/lichess-crawl/` (entire directory), `apps/workers/src/lichess-titled/`, `apps/workers/src/features/fast-lane-lichess.ts` (bulk CLI), `apps/workers/Dockerfile.lichess-crawl`, `apps/workers/src/lichess-dumps/extract-handles.ts` (seeded the dead queue).
- Preserved: `apps/workers/src/features/lichess-fingerprint-one.ts` (single-API-call per-user fingerprint for the account-link Inngest function — explicitly endorsed by Thomas as legitimate non-bulk use).
- Updated: `crawler-watchdog.ts` / `crawler-jobs.ts` / `crawl-refresh.ts` no longer dispatch or refresh Lichess. `prepare-reports.ts` surfaces "opponent not in corpus, Lichess updates monthly" for unknown Lichess opponents instead of enqueuing into a dead queue. `/api/prepare/enqueue` is a no-op for Lichess. `scout-ready.ts` derives Lichess readiness from games-in-corpus instead of queue-status.
- Tables `lichess_crawl_queue` and `lichess_crawl_runs` left in place (no consumers, no writes) for a separate drop migration later.

## Lessons for the next platform

When wiring up the next bulk scraper (chess.com expansion, ChessBase, FIDE deep crawl, anything new):

1. Cloud Run from day one. No "local first to gather numbers" — the numbers are in this postmortem.
2. Token + identifying User-Agent with resolving URL + contact email before the first request leaves the machine.
3. Per-IP concurrency=1 enforced at the platform level, not in module-scope mutex code.
4. Honor 429 Retry-After as a stop-the-line signal, not retry-and-continue.
5. Prefer official bulk channels (dumps, BigQuery exports, signed-URL archives) over per-resource API loops. If a platform publishes dumps, use them.
