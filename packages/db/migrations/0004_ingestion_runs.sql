-- ============================================================================
-- Migration: 0004_ingestion_runs
-- Phase 0 Week 5 — run-history table for ingestion workers (FIDE, USCF,
-- Lichess dumps, etc.). Surfaced in admin UI in Week 7.
-- ============================================================================

CREATE TABLE ingestion_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker text NOT NULL,                          -- 'fide' | 'uscf' | 'lichess_dump' | ...
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  triggered_by text,                             -- 'cron' | 'admin' | 'cli' | profile_id
  started_at timestamptz NOT NULL DEFAULT NOW(),
  completed_at timestamptz,
  metrics jsonb,                                 -- { downloaded_bytes, parsed, inserted, updated, skipped, snapshots, errors }
  error text,                                    -- short error message if status='failed'
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX ingestion_runs_worker_started_idx
  ON ingestion_runs (worker, started_at DESC);
CREATE INDEX ingestion_runs_status_idx
  ON ingestion_runs (status, started_at DESC) WHERE status <> 'completed';

ALTER TABLE ingestion_runs ENABLE ROW LEVEL SECURITY;
-- No SELECT/INSERT policies; service-role only (workers + admin tooling).
-- An admin-readable policy gets added in Week 7 when the admin UI lands.
