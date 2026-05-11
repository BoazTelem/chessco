# Chessco DB — Migrations

This directory contains hand-authored SQL migrations applied to the Supabase Postgres instance.

**Source of truth:** the `.sql` files here. The Drizzle TS schema in [`../src/schema.ts`](../src/schema.ts) mirrors what's deployed for app-side type safety, but the SQL is authoritative.

## How migrations are applied

Phase 0–1 use the Supabase MCP `apply_migration` tool from Claude Code:

1. Author/edit the `.sql` file here.
2. Apply via MCP (records in Supabase's `supabase_migrations.schema_migrations` table).
3. Commit the file.

Later phases (when we have CI deployment to staging/prod) will switch to:

- Local: `pnpm drizzle:generate` from schema.ts (generates SQL into this dir).
- CI: `supabase db push` or a custom runner that reads files here in order.

## Naming convention

`NNNN_short_description.sql` where `NNNN` is a 4-digit sequence number. Apply in numeric order. Never edit a migration that has been applied — write a new one instead.

## Current migrations (Phase 0 Week 2)

| File                                   | Description                                                                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001_core_schema.sql`                 | Extensions, helper functions, identity, federations, players, games, aggregates, prep_reports. Seeds the 6 federations rows (FIDE active, others inactive).                     |
| `0002_marketplace_wallet_fairplay.sql` | Challenges, matches, live_games, match_moves, wallets, ledger, ratings, refunds, fairplay, audit.                                                                               |
| `0003_rls_and_helpers.sql`             | RLS on every table with starter policies; `is_admin()` helper; `handle_new_user()` trigger that auto-creates profile + wallet + rating rows when an auth.users row is inserted. |

## Verifying schema state

Quick health check (via Supabase MCP or psql):

    SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';
    -- expected: 31

    SELECT count(*) FROM pg_policies WHERE schemaname = 'public';
    -- expected: 33+ (grows as we tighten RLS in later phases)

    SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto', 'pg_trgm', 'vector');
    -- expected: all three present

    SELECT count(*) FROM federations;
    -- expected: 6 (FIDE, USCF, ECF, DSB, FSI, FFE)

## Deferred work (Phase 1 onward)

These are intentionally **not** in the initial migrations and will land before they're needed:

- **`games` partitioning by `played_at` month** — adds before Phase 1 Lichess dump ingest. Spec §5 partitioning note.
- **HNSW vector index on `players.embedding`** — adds after embeddings start populating in Phase 2.
- **Tighter RLS policies on `ledger_entries`, `fairplay_telemetry`** — current default is restrictive (deny all to non-service-role); will be revisited as admin tooling lands in Phase 4–5.
- **`audit_logs` time-based partitioning** — once volume justifies (Phase 5+).
