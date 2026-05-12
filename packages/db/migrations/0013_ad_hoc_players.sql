-- ============================================================================
-- ad_hoc_players — user-created entries for people not in FIDE/ICF/USCF/…
-- ============================================================================
-- Scout flow Iteration 3 (2026-05-12): when a user searches /scout and gets
-- zero results, they can sign in and "track this person anyway" — creating
-- an ad-hoc player row. The drill-down page /p/adhoc/{id} mirrors the FIDE
-- profile and supports the same identification flows. Confirmed handle
-- identifications anchor back to the ad-hoc row, so future searches by
-- anyone in the same name/country surface the previously-found accounts.
--
-- created_by is NOT NULL — anonymous visitors can't create ad-hoc entries
-- (user-confirmed quality control to keep the corpus clean).
-- ============================================================================

CREATE TABLE ad_hoc_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  name_normalized text NOT NULL,
  country text,
  created_by uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX ad_hoc_players_name_trgm_idx
  ON ad_hoc_players USING gin (name_normalized gin_trgm_ops);
CREATE INDEX ad_hoc_players_created_by_idx ON ad_hoc_players (created_by);

ALTER TABLE identification_queries
  ADD COLUMN ad_hoc_player_id uuid REFERENCES ad_hoc_players(id) ON DELETE SET NULL;
CREATE INDEX identification_queries_ad_hoc_player_idx
  ON identification_queries (ad_hoc_player_id) WHERE ad_hoc_player_id IS NOT NULL;

ALTER TABLE identification_candidates
  ADD COLUMN ad_hoc_player_id uuid REFERENCES ad_hoc_players(id) ON DELETE SET NULL;
CREATE INDEX identification_candidates_ad_hoc_player_idx
  ON identification_candidates (ad_hoc_player_id) WHERE ad_hoc_player_id IS NOT NULL;
