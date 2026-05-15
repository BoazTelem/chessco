-- ============================================================================
-- chessco-games corpus — explicit features_version column on fingerprint tables
-- ============================================================================
-- Phase 0 of fingerprint A/B benchmarking infrastructure (2026-05-15):
-- before we evolve PlayerFeaturesV0 → V1 (or experiment with weights, add new
-- components like opening evaluations, change cp-loss windows, etc.) we need
-- a query-time version filter. Today the version is buried inside the JSONB
-- payload (`features.version: 'v0'`) — unindexed, unfilterable, only
-- recoverable by unpacking the blob.
--
-- This migration adds an explicit, indexed version column to the two
-- fingerprint storage tables. Existing rows backfill to 'v0' (the only
-- version we've ever produced).
--
-- Ship sequence:
--   1. This migration  (DB column + default backfill)        ← here
--   2. Update writers (extract.ts, fast-lane.ts) to explicitly
--      set features_version on every upsert
--   3. Update matchers (stage3/match.ts, scout/stage3.ts) to
--      filter WHERE features_version = $latest by default
--   4. When PlayerFeaturesV1 ships: writers stamp 'v1', matchers
--      can A/B-compare across versions in same query.
-- ============================================================================

ALTER TABLE style_features
  ADD COLUMN IF NOT EXISTS features_version text NOT NULL DEFAULT 'v0';

ALTER TABLE account_fingerprints
  ADD COLUMN IF NOT EXISTS features_version text NOT NULL DEFAULT 'v0';

-- The matcher's hot path is "find all rows of latest version" → narrow + fast.
-- Composite index (features_version, player_id) gives index-only scans for
-- "give me v0 rows for these players" lookups.
CREATE INDEX IF NOT EXISTS style_features_version_player_idx
  ON style_features (features_version, player_id);

CREATE INDEX IF NOT EXISTS account_fingerprints_version_idx
  ON account_fingerprints (features_version);

INSERT INTO games_corpus_migrations (id) VALUES ('0013_features_versioning');
