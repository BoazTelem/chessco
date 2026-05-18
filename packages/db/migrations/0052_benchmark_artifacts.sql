-- ============================================================================
-- Migration: 0052_benchmark_artifacts
-- Stores the JSON artifacts that the /benchmarks ("How it works") page used
-- to read from apps/web/public/*.json. Moving to a table lets the daily
-- refresh run anywhere with Supabase service-role access (Cloud Run, local
-- machine, Inngest) instead of forcing a GitHub Actions cron with extra
-- secrets to commit the JSON back. The page reads the latest row per kind
-- via the anon JS client.
--
-- Append-only by design: every refresh inserts a new row, matching the
-- corpus_index_counts pattern (migration 0020). 100KB x 365 days per kind
-- is a rounding error in storage and gives us refresh history for free.
-- ============================================================================

CREATE TABLE benchmark_artifacts (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('coverage_stats', 'sparse_cascade', 'legacy_repertoire')),
  data jsonb NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX benchmark_artifacts_latest_idx
  ON benchmark_artifacts (kind, refreshed_at DESC);

ALTER TABLE benchmark_artifacts ENABLE ROW LEVEL SECURITY;

-- Public read: /benchmarks is anonymous; the payloads are non-sensitive
-- aggregate stats (federation coverage %, PGN matching accuracy %).
CREATE POLICY benchmark_artifacts_anon_read ON benchmark_artifacts
  FOR SELECT TO anon, authenticated
  USING (true);

-- Writes restricted to service-role: no INSERT/UPDATE/DELETE policy means
-- non-service-role users cannot mutate the table.

COMMENT ON TABLE benchmark_artifacts IS
  'Append-only snapshots of /benchmarks page artifacts (coverage_stats, sparse_cascade, legacy_repertoire). Writers: apps/workers eval:coverage and eval:cascade scripts via service-role. Readers: apps/web /benchmarks page via anon, picking the latest row per kind.';
