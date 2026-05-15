-- ============================================================================
-- chessco-games corpus — time-bucketed repertoires
-- ============================================================================
-- Phase 2b refinement: store one tree per (player, color, depth, time_bucket)
-- so the matcher can compare an input PGN's era to the candidate's era,
-- not their all-time average. A grandmaster who switched openings in 2024
-- looks like two different players to a single 12-month tree; bucketed
-- trees let the matcher pick the contemporaneous one.
--
-- Buckets are NESTED, not exclusive: a game in the last 90 days is in
-- recent_3mo AND recent_12mo AND recent_36mo AND all_time. The build
-- worker writes one tree per non-empty bucket.
--
-- Existing rows are deleted (~20 from earlier backfill) — cheaper than
-- back-filling the new column on partial data, and the in-flight backfill
-- needs to re-run anyway under the new schema.
-- ============================================================================

DO $$
BEGIN
  -- Early versions of this file accidentally recorded
  -- `0010_repertoires_time_bucket` in the ledger. If a database already ran
  -- that version, the runner will try 0011 again because it keys off the
  -- filename. Guard the destructive reset so re-running only records the
  -- corrected migration id below.
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'player_repertoires'
      AND column_name = 'time_bucket'
  ) THEN
    DELETE FROM player_repertoires;

    ALTER TABLE player_repertoires
      ADD COLUMN IF NOT EXISTS time_bucket text NOT NULL DEFAULT 'all_time',
      ADD COLUMN IF NOT EXISTS bucket_since timestamptz,
      ADD COLUMN IF NOT EXISTS bucket_until timestamptz;

    ALTER TABLE player_repertoires
      DROP CONSTRAINT IF EXISTS player_repertoires_pkey;

    ALTER TABLE player_repertoires
      ADD PRIMARY KEY (player_id, color, depth, time_bucket);

    ALTER TABLE player_repertoires
      ADD CONSTRAINT player_repertoires_time_bucket_check
      CHECK (time_bucket IN ('recent_3mo', 'recent_12mo', 'recent_36mo', 'all_time'));
  END IF;
END $$;

-- Index for "find candidates whose bucket overlaps the input PGN era"
CREATE INDEX IF NOT EXISTS player_repertoires_window_idx
  ON player_repertoires (time_bucket, bucket_since, bucket_until);

INSERT INTO games_corpus_migrations (id) VALUES ('0011_repertoires_time_bucket')
ON CONFLICT (id) DO NOTHING;
