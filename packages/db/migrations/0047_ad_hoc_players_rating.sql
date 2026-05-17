-- ============================================================================
-- Migration: 0047_ad_hoc_players_rating
--
-- Closes the cold-tail fallback gap. When /scout finds nothing in FIDE/ICF/etc.
-- the user creates an ad-hoc anchor (0013_ad_hoc_players); today that anchor
-- carries only name + country, leaving Stage 2 with no rating signal. This
-- migration adds:
--
--   1. rating_estimate + rating_band_low/high — user-supplied rating with a
--      confidence window. Stage 2 scores candidates against this band the same
--      way FIDE-anchored queries score against federation_players.rating_*.
--
--   2. rating_source — provenance of the rating ('user_estimate' for
--      hand-typed, 'national_federation' / 'club' / 'self_reported' for
--      future ingestion paths). Stage 2 down-weights softer sources.
--
--   3. title — optional FIDE-style title (CM/FM/IM/GM/WGM/etc.) since a
--      user who knows the rating often knows the title too; tightens
--      Stage 2 title-match scoring.
--
--   4. Promotion bookkeeping (promotion_status, confirmed_match_count,
--      last_confirmed_at, promoted_federation_player_id) — when ≥2 distinct
--      authenticated users confirm the same online account against an ad-hoc
--      entry, a nightly worker (apps/workers/src/identification/promote-ad-hoc.ts)
--      flips promotion_status to 'promoted'. Promoted rows surface in /scout
--      under a "Community-verified" section. We deliberately do NOT auto-create
--      federation_players rows — provenance stays clean and we never claim
--      community data is canonical.
-- ============================================================================

ALTER TABLE ad_hoc_players
  ADD COLUMN rating_estimate int,
  ADD COLUMN rating_band_low int,
  ADD COLUMN rating_band_high int,
  ADD COLUMN rating_source text CHECK (
    rating_source IN ('user_estimate', 'national_federation', 'club', 'self_reported')
  ),
  ADD COLUMN title text,
  ADD COLUMN promotion_status text NOT NULL DEFAULT 'pending' CHECK (
    promotion_status IN ('pending', 'promoted', 'duplicate_of_fide', 'rejected')
  ),
  -- Soft pointer (not FK) — we don't want a federation_players delete to
  -- cascade-clear the promotion provenance. federation_players.id is uuid.
  ADD COLUMN promoted_federation_player_id uuid,
  ADD COLUMN confirmed_match_count int NOT NULL DEFAULT 0,
  ADD COLUMN last_confirmed_at timestamptz;

-- Band integrity: if you give a band you give both ends, and low <= high.
ALTER TABLE ad_hoc_players
  ADD CONSTRAINT ad_hoc_players_rating_band_paired_chk CHECK (
    (rating_band_low IS NULL AND rating_band_high IS NULL)
    OR (rating_band_low IS NOT NULL AND rating_band_high IS NOT NULL AND rating_band_low <= rating_band_high)
  );

-- The promote-ad-hoc worker scans by (status, confirmed_match_count DESC) to
-- process the most-confirmed pending rows first.
CREATE INDEX ad_hoc_players_promotion_idx
  ON ad_hoc_players (promotion_status, confirmed_match_count DESC);
