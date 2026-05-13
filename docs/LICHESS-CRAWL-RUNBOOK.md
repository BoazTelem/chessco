# Lichess Crawl — Operational Runbook

Per-handle Lichess crawler — sibling of the chess.com crawler. Pulls each
handle's last 12 months of rated standard games via `GET /api/games/user/`
into the games-corpus, where `features:run` produces stylometric
fingerprints alongside the chess.com ones.

The MVP seed pool is **every Lichess handle in the existing `handles`
table with ≥ 10 games** — about 1,400 from the 2013-01 dump plus any new
ones added since. Growing this seed beyond the 2013 cohort is a planned
follow-up (see "Out of scope" in the original plan file).

## Pre-flight checklist

1. **Cloud SQL reachable.** `pnpm --filter @chessco/workers games-db:verify`
   should succeed.
2. **Apply migration 0005.**
   ```powershell
   pnpm --filter @chessco/workers games-db:migrate
   ```
   Look for `→ applying 0005_lichess_crawl_queue…` in the output.
3. **No Windows-Update interruption planned** during the crawl window.

## Smoke test (do this first)

Seed a single, well-known Lichess handle and process it end-to-end. Should
complete in a minute or two and confirm the streaming PGN parse +
ingestion path.

```powershell
# 1. Seed one handle (Magnus Carlsen's Lichess account).
pnpm --filter @chessco/workers lichess:crawl:seed --handle drnykterstein

# 2. Process exactly that one item.
pnpm --filter @chessco/workers lichess:crawl --max-items 1
```

Sanity checks afterwards:

```powershell
pnpm --filter @chessco/workers lichess:crawl:status
```

You should see: one `done` row in the queue, hundreds of new `lichess`
games in `games` table (DrNykterstein plays a lot of bullet), a recent
`lichess_crawl_runs` row with `items_processed=1`.

## Full backfill

```powershell
# 1. Seed everyone in handles with platform='lichess' and ≥10 games.
pnpm --filter @chessco/workers lichess:crawl:seed

# 2. Run the crawler under the auto-restart loop wrapper.
.\apps\workers\scripts\lichess-crawl-loop.ps1 -ExitWhenEmpty
```

For ~1,400 handles at ~2 s each with parse+ingest overhead: expect
**~3–5 hours** to drain. Far shorter than the chess.com run because
there are far fewer handles.

## Monitoring

```powershell
pnpm --filter @chessco/workers lichess:crawl:status
```

Or in SQL:

```sql
SELECT status, COUNT(*) FROM lichess_crawl_queue GROUP BY status;

SELECT
  COUNT(*) AS items_completed_last_hour,
  SUM(games_inserted) AS games_ingested_last_hour
FROM lichess_crawl_queue
WHERE completed_at > NOW() - INTERVAL '1 hour';

SELECT id, worker_id, items_processed, games_inserted, errors,
       NOW() - last_heartbeat_at AS since_heartbeat
FROM lichess_crawl_runs
WHERE status = 'running'
ORDER BY started_at DESC;
```

## After the run — refresh fingerprints

```powershell
pnpm --filter @chessco/workers features:run --source lichess
```

This recomputes the Lichess column of `style_features` from all
`source='lichess'` games (the new crawled ones + the legacy 2013-01
dump's games). Re-run periodically as the corpus grows.

## Tuning the pacing

`--rate-ms 2000` is the conservative default (≈ 30 req/min). If the
canary runs clean for hours and you see zero 429s, drop to 1000 ms. Do
NOT drop below 1000 ms — Lichess user-export is stricter than chess.com
on this endpoint and a sustained 429 stream means a multi-hour IP cool-
down.

```powershell
.\apps\workers\scripts\lichess-crawl-loop.ps1 -RateMs 1000
```

## Running alongside the chess.com crawler

The two crawlers hit different APIs, so per-IP rate budgets are
independent. You can safely run one of each on the same machine. But
both write to the same Cloud SQL `positions` / `games` / `moves`
tables — write contention may surface as Postgres deadlocks. Watch the
`errors` counter on both runs; if it climbs > 20/hr combined, consider
sorting `fen_hash` before insert in `ingestBatch` (planned follow-up).

## Stopping

Ctrl+C in the loop's PowerShell window. The signal handler finishes
the current item or releases it back to `pending`, marks the run
`stopped`, and exits. Queue state survives across restarts.

## Known limitations (today)

- **Seed is the 2013 cohort.** Many of those handles are now inactive
  or have closed accounts (404 from Lichess). Those auto-complete with
  0 games, no error. Growing the seed beyond 2013 is planned.
- **Anonymous-only.** No OAuth token integration. Anonymous pacing is
  fine for ~1,400 handles. If we grow the seed to 100k+, OAuth's 4x
  rate increase becomes worth integrating.
- **No transitive opponent discovery yet.** A future enhancement could
  enqueue the opponents of crawled handles, growing the corpus
  organically.
