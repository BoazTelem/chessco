# Lichess crawl — RETIRED

> **This runbook is retired.** The per-handle Lichess API crawler was deleted on 2026-05-18 after Lichess (`contact@lichess.org`) confirmed that bulk per-handle enumeration via `/api/games/user/` is forbidden regardless of pacing or IP origin.
>
> See [INCIDENT-2026-05-18-lichess-ip-block.md](./INCIDENT-2026-05-18-lichess-ip-block.md) for the full postmortem.

## What replaced it

| Use case                                                         | New path                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bulk Lichess game corpus                                         | **Monthly dumps** via [apps/workers/src/lichess-dumps/](../apps/workers/src/lichess-dumps/). Endorsed by Lichess for bulk consumers.                                                                     |
| Per-user fingerprint on account-link (single API call, not bulk) | `runLichessFingerprintOne` in [apps/workers/src/features/lichess-fingerprint-one.ts](../apps/workers/src/features/lichess-fingerprint-one.ts), invoked by the `account.linked.lichess` Inngest function. |
| Live games for a user visiting `/prepare/lichess/[handle]`       | Client-side fetch in `apps/web/lib/prepare/fetch-lichess.ts` (single user, on-demand, not bulk).                                                                                                         |

## What's gone

| Removed                                                                                                                                                                   | Replacement                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `apps/workers/src/lichess-crawl/` (entire directory)                                                                                                                      | —                                                              |
| `apps/workers/src/lichess-titled/run.ts`                                                                                                                                  | Dumps capture `[WhiteTitle]/[BlackTitle]` PGN headers directly |
| `apps/workers/src/features/fast-lane-lichess.ts` (bulk CLI)                                                                                                               | `lichess-fingerprint-one.ts` (per-user only)                   |
| `apps/workers/Dockerfile.lichess-crawl`                                                                                                                                   | —                                                              |
| `apps/workers/src/lichess-dumps/extract-handles.ts` (seeded the dead queue)                                                                                               | —                                                              |
| `apps/workers/scripts/lichess-crawl-loop.ps1`                                                                                                                             | —                                                              |
| `LICHESS_REGIONS` + Lichess dispatch path in `crawler-watchdog.ts` / `crawler-jobs.ts`                                                                                    | —                                                              |
| `crawlRefreshLichess` Inngest function                                                                                                                                    | —                                                              |
| pnpm scripts: `lichess:crawl`, `lichess:crawl:seed`, `lichess:crawl:status`, `lichess:crawl:refresh`, `lichess:titled`, `lichess:dump:scan`, `features:fast-lane-lichess` | —                                                              |

## Tables still exist (intentionally)

`lichess_crawl_queue` and `lichess_crawl_runs` remain in the games DB. No code reads or writes them as of 2026-05-18. They are scheduled for removal in a follow-up migration once we're confident no consumers remain. Until then they sit dormant.

## Why not just route the same crawler through Cloud Run?

Because the issue isn't the egress IP, it's the access pattern itself. From Thomas at Lichess (2026-05-18):

> The Lichess API isn't designed for bulk user enumeration and uses rate limiting to prevent it. Instead, please use the game database dumps at https://database.lichess.org/ like you identified.

Multiple regional IPs running the same loop would have ended up blocked in turn. The structural fix is to use the channel Lichess intends for bulk: the monthly dumps.

See also: [CLOUD-RUN-CRAWLERS.md](./CLOUD-RUN-CRAWLERS.md) for the chess.com crawler (which is API-allowed for bulk and still runs on Cloud Run).
