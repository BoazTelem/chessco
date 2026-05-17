# Runbook — database restore

**When** Supabase or Cloud SQL needs point-in-time restore — typically after a destructive migration, a bug that wrote bad data en masse, or a regional outage.

**Goal** restore to the last known-good point with minimal data loss. Both stores have PITR enabled per `docs/SETUP-CLOUDSQL.md` §1 and Supabase default settings.

## Steps — Supabase (auth, profiles, identification, prep_reports, …)

1. Open the Supabase dashboard → Database → Backups.
2. Choose the target point-in-time. Default retention is 7 days.
3. Restore to a **new** database, not the existing one. Supabase doesn't support in-place PITR.
4. Once the new DB is up:
   - Take a snapshot of the current (broken) DB for forensics.
   - Update the `DATABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL` envs at Vercel + Fly to point at the new DB.
   - Verify with `pnpm ingest:status`.
5. Swap auth tokens (Supabase Auth signing secret) only if the breach involved JWT compromise.

## Steps — Cloud SQL games corpus

1. Open GCP Console → SQL → `chessco-games` → Backups.
2. Choose the target backup or initiate point-in-time recovery.
3. Cloud SQL can clone in place to a new instance; do that.
4. Update `GAMES_DATABASE_URL` env at workers + Vercel.
5. Verify with `pnpm ingest:status` (Cloud SQL row).

## Verify

- `pnpm ingest:status` reports both DBs reachable.
- A known sample query returns expected rows (e.g. `SELECT COUNT(*) FROM federation_players WHERE federation_id = 'FIDE'`).
- Smoke the user-facing pages: `/`, `/scout`, `/prepare`, `/practice`, `/account/wallet`.

## Escalate

- Restore would lose >1h of data: compare to the cost of replaying the period (Lichess dumps + chess.com crawl can be re-run). Pick the smaller loss.
- Supabase support: file via dashboard with an incident ticket; their on-call gets paged.
- Cloud SQL: GCP P1 ticket if region-wide.
