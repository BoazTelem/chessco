# Phase 1 ingest backbone — status & bring-up sequence

Audited 2026-05-17 as part of WS-2. This doc is the single source of truth for "what's wired" vs "what's gated on operator action" for the Phase 1 corpus pipeline.

---

## Quick check

    pnpm --filter @chessco/workers ingest:status

Probes both Postgres backends, prints reachability + row counts + freshness for the corpus tables, and exits non-zero if anything is unreachable or stale. Run it any time you want to know "is the backbone alive?". JSON mode: `... ingest:status --json` for piping.

Exit codes:

| Code | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| 0    | Both DBs reachable and every monitored table is within freshness budget |
| 1    | Reachable but at least one row is stale or empty                        |
| 2    | At least one DB is unreachable                                          |

---

## What's wired in code (no operator action needed)

| Component                                    | Code path                                                         | Spec target                   | Status                                              |
| -------------------------------------------- | ----------------------------------------------------------------- | ----------------------------- | --------------------------------------------------- |
| Two-DB connection layer (Supabase + games)   | `apps/workers/src/db.ts`                                          | both required                 | ✓ wired                                             |
| FIDE monthly ingest                          | `apps/workers/src/fide/run.ts`                                    | §6, must-have                 | ✓ wired (755k rows in prod)                         |
| ICF (Israel CF) ingest                       | `apps/workers/src/icf/`                                           | §6, Phase 0 W6                | ✓ wired (6,818 rows in prod)                        |
| USCF ingest                                  | `apps/workers/src/uscf/run.ts`                                    | §6, Phase 0 W7                | ✗ Cloudflare blocked (FIDE-USA fallback documented) |
| Lichess monthly dump worker                  | `apps/workers/src/lichess-dumps/run.ts`                           | §6, must-have, monthly        | ✓ wired; idempotent via `resume.ts`                 |
| Lichess per-handle crawler                   | `apps/workers/src/lichess-crawl/`                                 | §6                            | ✓ wired                                             |
| Chess.com PubAPI crawler                     | `apps/workers/src/chesscom-crawl/`                                | §6, must-have, 7-day cache    | ✓ wired                                             |
| Chess.com 7-day refresh                      | `apps/workers/src/chesscom-crawl/refresh-stale.ts:31`             | spec §6 7-day cache           | ✓ confirmed                                         |
| Chess.com titled-player titles               | `apps/workers/src/chesscom-titled/`                               | spec §6                       | ✓ wired                                             |
| Stockfish backfill (cp-loss, blunder flags)  | `apps/workers/src/stockfish/backfill.ts`                          | §6 "depth 18 default"         | ✓ default raised to 18 in WS-2                      |
| Features extractor (style / fingerprint)     | `apps/workers/src/features/`                                      | §6 Stage 3 (200–500 features) | 🚧 partial — finished in WS-4                       |
| Stage 2 online-account matching              | `apps/workers/src/identification/`                                | §6 Stage 2                    | ✓ wired                                             |
| Stage 3 verification                         | `apps/workers/src/stage3/`                                        | §6 Stage 3                    | ✓ wired                                             |
| Inngest cron wrappers                        | `apps/workers/src/inngest/serve.ts`                               | scheduled runs                | ✓ wired                                             |
| Cloud SQL bootstrap migrate + smoke + verify | `apps/workers/src/games-db-{migrate,smoke,verify,state-check}.ts` | post-provisioning             | ✓ wired                                             |

---

## Operator-gated (Boaz does these in GCP)

Per [SETUP-CLOUDSQL.md](SETUP-CLOUDSQL.md) and [SETUP-CLOUDRUN-WORKERS.md](SETUP-CLOUDRUN-WORKERS.md):

1. **Cloud SQL Frankfurt instance** — create `chessco-games` (PostgreSQL 17, Enterprise, 2 vCPU / 8 GB / 100 GB SSD with auto-grow, single-zone, europe-west3, public IP, SSL required).
2. **Extensions** — `pgcrypto`, `pg_stat_statements`, `pg_trgm` enabled by superuser.
3. **`chessco_worker` user** — least-privilege role.
4. **Workers env** — `GAMES_DATABASE_URL` (or `GAMES_DATABASE_HOST/PORT/USER/PASSWORD`) set in worker runtime + Vercel.
5. **Cloud Run worker deploys** — Docker images for `lichess-crawl`, `chesscom-crawl`, `uscf`, `inngest`, `stockfish` (see Dockerfiles in `apps/workers/`).

After (1)–(4), `pnpm ingest:status` flips Supabase to ✓ and Cloud SQL to ✓ with empty counts. After the first Lichess dump + chess.com crawl pass, the corpus rows appear.

---

## Standard bring-up sequence (once Cloud SQL credentials land)

    # 1. Bootstrap schema on the new games DB.
    pnpm --filter @chessco/workers games-db:migrate
    pnpm --filter @chessco/workers games-db:verify

    # 2. Confirm health.
    pnpm --filter @chessco/workers ingest:status

    # 3. Seed the chess.com queue (titled players + country fan-outs).
    pnpm --filter @chessco/workers chesscom:crawl:seed
    pnpm --filter @chessco/workers chesscom:titled
    pnpm --filter @chessco/workers chesscom:country

    # 4. Start the long-running crawlers (Cloud Run jobs or local loops).
    pnpm --filter @chessco/workers chesscom:crawl
    pnpm --filter @chessco/workers lichess:crawl

    # 5. Ingest a Lichess monthly dump.
    pnpm --filter @chessco/workers lichess:dump 2026-04

    # 6. Backfill Stockfish at spec depth 18 (long-running; budget-bound).
    pnpm --filter @chessco/workers exec tsx src/stockfish/backfill.ts \
      --workers 4 --depth 18 --batch 200 --scout-ready-only

    # 7. Recompute fingerprints + run benchmarks.
    pnpm --filter @chessco/workers features:run
    pnpm --filter @chessco/workers bench:all

---

## Idempotency and resumability

- **Lichess dumps:** `apps/workers/src/lichess-dumps/resume.ts` records dump progress per `(dump_id, byte_offset)`. Re-running the same `YYYY-MM` resumes from the last checkpoint; safe to kill and restart.
- **Chess.com crawl:** `chesscom_crawl_queue` rows are `pending → in_progress → done`. Workers claim with `FOR UPDATE SKIP LOCKED`; restarting workers cannot double-process a row. `refresh-stale.ts` flips `done` rows back to `pending` after the 7-day TTL.
- **Stockfish backfill:** writes `analyzed_at` on `games`. Re-running skips analyzed rows by default. Per-handle mode (`--platform --handle`) re-analyzes regardless and is the path the personalized-leaks feature uses.
- **Lichess per-handle crawl:** parallel queue similar to chess.com; sharded by handle hash.

---

## Freshness thresholds the status CLI uses

| Surface               | Threshold | Source                          |
| --------------------- | --------- | ------------------------------- |
| FIDE rating snapshots | 35 days   | monthly FIDE cycle              |
| Lichess games         | 45 days   | monthly dump lands mid-month    |
| chess.com games       | 14 days   | 7-day cache TTL ×2 jitter       |
| Stockfish analysis    | 7 days    | continuous backfill expectation |

Tune in [ingest-status.ts](apps/workers/src/ingest-status.ts) `STALE_DAYS` if cadence changes.

---

## Known gaps and follow-ups

1. **Cloud SQL provisioning** is manual GCP work — operator-gated per [SETUP-CLOUDSQL.md](SETUP-CLOUDSQL.md).
2. **Cloud Run image deploys** are operator-gated per [SETUP-CLOUDRUN-WORKERS.md](SETUP-CLOUDRUN-WORKERS.md).
3. **USCF** is Cloudflare-blocked; FIDE-USA slice (13,220 OTB-rated US players) covers the gap per [PLAN.md](PLAN.md).
4. **Wave-B federations (ECF/DSB/FFE)** are bulk-source-blocked; FIDE-slice substitution routes already exist.
5. **Stage 3 feature completeness** (engineered features at 200–500 per player) lands in WS-4 (CQ-1 identification).
