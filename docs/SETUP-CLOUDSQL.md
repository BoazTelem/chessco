# Setup Checklist — Google Cloud SQL (games corpus)

The dedicated games-corpus database. Lives separate from Supabase so the 400–600GB Lichess + chess.com corpus doesn't push Supabase past its tier. See [`PLAN.md`](PLAN.md) "Locked Decisions" for the rationale.

**Region:** `europe-west3` (Frankfurt). Same region as the Supabase project for low cross-DB query latency.

**You** (Boaz) do steps 1–5 in GCP. **Claude** wires the workers + Drizzle schema once credentials land.

---

## 1. Create the Cloud SQL instance

1. https://console.cloud.google.com/sql/instances (in your existing GCP project — same one as the `chessco` Auth Platform setup)
2. **Create Instance** → **PostgreSQL**
3. **Instance ID:** `chessco-games`
4. **Database version:** **PostgreSQL 17** (match Supabase)
5. **Cloud SQL edition:** **Enterprise** (the standard tier, not Enterprise Plus — Enterprise Plus is overkill until we have real traffic)
6. **Preset:** **Production** with these tuned-down knobs:
   - vCPUs: **2**
   - Memory: **8 GB**
   - Storage type: **SSD**
   - Storage size: **100 GB** (with auto-increase enabled — corpus will grow past this)
7. **Region:** **europe-west3 (Frankfurt)** — single zone is fine for starter, switch to HA later
8. **Zonal availability:** Single zone (saves ~50%, fine for non-launch data)
9. **Connections:**
   - Public IP: ✅ enabled (we'll use it from Vercel + workers)
   - Private IP: skip for now
   - **Authorized networks:** add `0.0.0.0/0` initially — we'll lock down to Vercel egress IPs later. (Workers connect with SSL, which is enforced by default.)
10. **Data protection:**
    - Automated backups: enabled, 7-day retention
    - Point-in-time recovery: enabled (small cost, big safety net)
11. **Maintenance:**
    - Window: Sunday 4 AM UTC
    - Order: Later (so it's not first to receive new releases)
12. Set the `postgres` user password — **alphanumeric only** (avoid `@:/?#` to dodge URL-encoding pain we hit on Supabase). Suggestion: open a password manager, generate 20 alphanumeric chars
13. **Create** — provisioning takes 5–10 min

**Estimated cost:** ~$70/mo for the 2vCPU/8GB starter. Will scale up to ~$150-300/mo once the Lichess corpus is ingested.

## 2. Enable extensions on the new instance

Once provisioned, in the **Cloud SQL → chessco-games → Databases** tab, ensure the default `postgres` database exists. Then enable extensions via the **Flags** section OR via SQL once connected:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;        -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_partman;       -- (if available) for automated partition rotation
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

Note: pgvector is NOT needed on this DB (vectors live on Supabase `players.embedding`). pg_trgm not needed either (federation player search stays on Supabase).

## 3. Create a dedicated `chessco_worker` user

For workers to connect with least-privilege:

```sql
CREATE USER chessco_worker WITH PASSWORD 'GENERATE_ANOTHER_ALPHANUMERIC';
GRANT CONNECT ON DATABASE postgres TO chessco_worker;
GRANT USAGE, CREATE ON SCHEMA public TO chessco_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO chessco_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO chessco_worker;
```

Save both passwords (postgres + chessco_worker) in your password manager.

## 4. Capture credentials

Note the **Public IP address** from the Cloud SQL Instance overview page. The connection string format:

```
postgresql://chessco_worker:[PASSWORD]@[PUBLIC_IP]:5432/postgres?sslmode=require
```

Cloud SQL **requires SSL** by default. The `sslmode=require` (or higher: `verify-ca` / `verify-full`) must be in the connection string.

## 5. Hand off to Claude

Paste back here (in this format):

```
GAMES_DATABASE_HOST=<public IP>
GAMES_DATABASE_PORT=5432
GAMES_DATABASE_USER=chessco_worker
GAMES_DATABASE_PASSWORD=<the chessco_worker password>
GAMES_DATABASE_NAME=postgres
GAMES_DATABASE_SSLMODE=require
```

⚠️ The password lands in this transcript (same as Supabase did). Rotate it after Phase 1 W1 worker is validated. Default rotation cadence per spec §24: monthly for sensitive credentials.

---

## What Claude does once these arrive

1. **Add `GAMES_DATABASE_*` to `apps/workers/.env`** (gitignored)
2. **Extend `apps/workers/src/db.ts`** with a second `getGamesDb()` factory that uses these env vars
3. **Write `packages/db/migrations/games-corpus/0001_initial.sql`** — `games` partitioned by `played_at` month + `positions` + `moves` + `player_position_stats` + `player_opening_stats` + `style_features`
4. **Apply the migration** to Cloud SQL via the worker
5. **Drop the old empty copies of these tables from Supabase** (they were created in migration 0001 there but never had data; cleaner to remove). New migration `0007_drop_games_tables_supabase.sql` on the Supabase side.
6. **Scaffold `apps/workers/src/lichess-dumps/`** — the dump downloader + zstd streaming parser. First dump processed locally; Cloud Run automation comes later (see memory: `lichess_dump_compute_decision.md`)

## Things to NOT do yet

- Don't enable HA (regional availability) — single zone is fine for starter
- Don't add read replicas — premature
- Don't enable Cloud SQL Insights premium — basic monitoring is included
- Don't size up to 4+ vCPUs yet — 2 vCPU handles the W1 ingest; we'll scale up when query load justifies

## Verification (once you've handed off credentials)

I'll run a smoke test that confirms:

- `psql "postgresql://chessco_worker:.../postgres"` connects with SSL
- `SELECT version()` returns Postgres 17
- A 1MB test write completes in <100ms (latency from Vercel/workers to Cloud SQL)
- The Cloud SQL instance is in europe-west3 region

If all green, we move to schema migration + first Lichess dump run.
