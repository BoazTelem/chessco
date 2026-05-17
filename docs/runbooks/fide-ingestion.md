# Runbook — FIDE ingestion

**When** monthly FIDE crawl failed, partial, or `federation_rating_snapshots` row count drifted ±1% from the previous month.

**Goal** the canonical FIDE rating list mirrors the published month within 24h; `/scout` reflects current ratings.

## Steps

1.  Probe state:

        pnpm --filter @chessco/workers ingest:status

    Expect `federation_rating_snapshots` fresh within 35 days. If stale, continue.

2.  Re-run the ingester pointing at the latest month's TRF/XML:

        pnpm --filter @chessco/workers fide:ingest

    Use `fide:ingest:test` with `--max-players 100` first if you want a smoke run.

3.  Verify Supabase row counts vs. the FIDE official totals page (https://ratings.fide.com/download.phtml):

    pnpm --filter @chessco/workers fide:ingest -- --verify-only

4.  Spot-check 3 known players (Magnus Carlsen, Hikaru Nakamura, Gukesh D) at `/scout` and `/p/{id}` to confirm the new ratings render.

## Verify

- `pnpm ingest:status` shows `federation_rating_snapshots` with `latest` within last 7 days.
- Banner on `/scout/federation/[code]` reflects the new month.

## Escalate

- FIDE source format changed: open an issue, attach the parser error + a sample bad row. The parser is at `apps/workers/src/fide/run.ts`.
- Cloud SQL ran out of storage during ingest: auto-grow should kick in; if it didn't, scale storage in GCP console.
