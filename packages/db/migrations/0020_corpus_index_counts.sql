-- ============================================================================
-- Migration: 0020_corpus_index_counts
-- ============================================================================
-- Surfaces live chess.com + Lichess crawl progress on the homepage.
-- The crawlers write to games-corpus (separate DB on Cloud SQL); the
-- homepage reads from Supabase. An hourly Inngest job
-- (apps/workers/src/inngest/corpus-counts.ts) snapshots distinct
-- handles + game counts into this table for the homepage RPC to surface.
-- ============================================================================

CREATE TABLE corpus_index_counts (
  id bigserial PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('chess.com', 'lichess')),
  distinct_handles bigint NOT NULL,
  total_games bigint NOT NULL,
  snapshot_at timestamptz NOT NULL DEFAULT NOW()
);

-- Hot path: "give me the latest snapshot per source"
CREATE INDEX corpus_index_counts_latest_idx
  ON corpus_index_counts (source, snapshot_at DESC);

-- Read access for the SECURITY DEFINER RPC. Direct selects from the
-- table itself are not exposed to anon.
GRANT SELECT ON corpus_index_counts TO postgres;

COMMENT ON TABLE corpus_index_counts IS
  'Hourly snapshot of games-corpus handle + game counts per source. Written by Inngest corpus-counts cron; read by public_index_stats RPC.';
