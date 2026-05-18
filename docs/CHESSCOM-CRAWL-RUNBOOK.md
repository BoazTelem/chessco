# Chess.com Crawl — Operational Runbook

> **Production runs ONLY from Cloud Run. See [CLOUD-RUN-CRAWLERS.md](./CLOUD-RUN-CRAWLERS.md).**
>
> Following the 2026-05-18 Lichess IP block ([INCIDENT-2026-05-18-lichess-ip-block.md](./INCIDENT-2026-05-18-lichess-ip-block.md)), bulk scraping from the office static IP is **forbidden** for every platform, not just Lichess — chess.com may block the same way and the office IP is also the user's personal access. Anything beyond a 1–2 item smoke test must dispatch to a Cloud Run job. The "Full backfill" section below documents the local invocation for historical reference only — do not run it. The PowerShell `*-crawl-loop.ps1` wrappers have been removed; restore from git history only if you also have written Cloud Run authorisation for the run.

chess.com PubAPI crawler. Pulls each handle's last 12 months of
rated-standard archives and ingests them into the games-corpus DB, where
`features:run` can turn them into stylometric fingerprints.

Estimated end-to-end on Cloud Run (4 parallel regions per [CLOUD-RUN-CRAWLERS.md](./CLOUD-RUN-CRAWLERS.md)):
**~12–36 hours** for the current ~50–80k titled+country seed pool at the
default 2-second pacing per region.

## Pre-flight checklist

1. **Cloud SQL reachable.** `pnpm --filter @chessco/workers games-db:verify`
   should succeed. The crawler writes ~150–300 GB over the full run; make
   sure the instance has headroom.
2. **Supabase has chess.com handles.** Run `chesscom:titled` and
   `chesscom:country` first if you haven't — those populate
   `platform_players`, which the crawler seeds from.
   ```powershell
   pnpm --filter @chessco/workers chesscom:titled --no-enrich
   pnpm --filter @chessco/workers chesscom:country IL US GB
   ```
3. **Apply migration 0003.**
   ```powershell
   pnpm --filter @chessco/workers games-db:migrate
   ```
   Look for `→ applying 0003_chesscom_crawl_queue…` in the output.
4. **Disable Windows sleep and pause Windows Update.** Settings → System →
   Power → Screen and sleep → Never (when plugged in). Settings → Windows
   Update → Pause updates → 35 days.

## Smoke test (do this first)

Seed 100 handles and process at most 50 queue items. Should complete in
2–4 minutes and confirm the pipeline end-to-end.

```powershell
# 1. Seed a small pool.
pnpm --filter @chessco/workers chesscom:crawl:seed --limit 100

# 2. Process up to 50 items (mix of archives_list + archive_month).
pnpm --filter @chessco/workers chesscom:crawl --max-items 50 --rate-ms 2000
```

Sanity checks after:

```sql
-- via psql or your Cloud SQL console
SELECT status, COUNT(*) FROM chesscom_crawl_queue GROUP BY status;
SELECT COUNT(*) FROM games WHERE source = 'chess.com';
SELECT * FROM chesscom_crawl_runs ORDER BY started_at DESC LIMIT 3;
```

You should see: some `done` rows in the queue, some `chess.com` games
landing in `games`, and a `chesscom_crawl_runs` row with `items_processed

> 0`and a recent`last_heartbeat_at`.

## Full backfill

```powershell
# 1. Seed the full Supabase pool (titled + country + lazy).
pnpm --filter @chessco/workers chesscom:crawl:seed

# 2. Run the crawler under the auto-restart loop wrapper.
.\apps\workers\scripts\chesscom-crawl-loop.ps1 -ExitWhenEmpty
```

`-ExitWhenEmpty` means: stop when there's no work left. Without it the
crawler sleeps (default 60 s) on an idle queue and rechecks — useful if
the lazy fetcher is also adding rows live.

Per-iteration crawler output streams to the console live. Loop-level events
(start, restart-on-crash, exit) are logged to
`apps/workers/logs/chesscom-crawl.log`. For unattended runs, redirect stdout:

```powershell
.\apps\workers\scripts\chesscom-crawl-loop.ps1 -ExitWhenEmpty `
  *> apps\workers\logs\chesscom-crawl-full.log
```

## Monitoring

Quick one-liner for a snapshot of queue + games + recent runs:

```powershell
pnpm --filter @chessco/workers chesscom:crawl:status
```

For deeper queries:

```sql
-- Progress
SELECT status, COUNT(*) FROM chesscom_crawl_queue GROUP BY status ORDER BY status;

-- Throughput (last hour)
SELECT
  COUNT(*) AS items_completed_last_hour,
  SUM(games_inserted) AS games_ingested_last_hour
FROM chesscom_crawl_queue
WHERE completed_at > NOW() - INTERVAL '1 hour';

-- Active worker heartbeat (should update at least every minute)
SELECT id, worker_id, items_processed, games_inserted, errors,
       NOW() - last_heartbeat_at AS since_heartbeat
FROM chesscom_crawl_runs
WHERE status = 'running'
ORDER BY started_at DESC;

-- Recent permanent failures (worth eyeballing)
SELECT handle, archive_url, attempts, last_error
FROM chesscom_crawl_queue
WHERE status = 'error_permanent'
ORDER BY completed_at DESC
LIMIT 20;
```

## Stopping

Press `Ctrl+C` in the loop's PowerShell window. The crawler's signal
handler finishes the current item (or releases it back to `pending`),
marks the run `stopped`, and exits.

On restart the queue is exactly where you left it. Stale `in_progress`
rows (worker died without releasing) are reset to `error_retry` on the
next start, automatically.

## Tuning the pacing

The 2-second default = 30 req/min, matches PLAN.md and is courteous to
chess.com. If you observe sustained zero 429s after a day, you can drop
to 1 second (60 req/min):

```powershell
.\apps\workers\scripts\chesscom-crawl-loop.ps1 -RateMs 1000
```

If you start seeing 429s in stderr.log or `last_error`, back off — the
chess.com API throttles per-IP and a few minutes at 60 req/min is enough
to get the cool-down treatment for the rest of the day.

## Re-seeding new handles mid-run

The `--exit-when-empty` flag closes the worker when the queue drains. If
the lazy fetcher or a fresh `chesscom:titled` run adds new handles
while the crawler is running:

- Without `--exit-when-empty`: crawler picks them up on its next idle
  check (default 60 s).
- With `--exit-when-empty`: re-seed, then re-run the loop script.

```powershell
pnpm --filter @chessco/workers chesscom:crawl:seed --pulled-via titled
```

## What happens when handles are gone / private / banned

- 404 on `/games/archives` → marked `error_permanent` after retries
- 404 on a single archive month → that month is marked `done` with 0
  games (chess.com sometimes lists archive URLs that 404 — known quirk)
- 410 / "closed account" → `error_permanent` after retries

These are expected; check `error_permanent` rows occasionally but don't
treat them as bugs.
