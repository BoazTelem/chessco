-- ============================================================================
-- Migration: 0006_add_icf_federation
-- Phase 0 Week 6 — adds Israeli Chess Federation to the federations table
-- so the ICF ingestion worker has its parent FK.
-- ============================================================================

INSERT INTO federations (id, name, country, rating_list_url, rating_list_format, sync_cadence, active)
VALUES (
  'ICF',
  'Israel Chess Federation',
  'IL',
  'https://www.chess.org.il/Players/PlayersRanking.aspx',
  'html',
  'monthly',
  true
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  country = EXCLUDED.country,
  rating_list_url = EXCLUDED.rating_list_url,
  rating_list_format = EXCLUDED.rating_list_format,
  sync_cadence = EXCLUDED.sync_cadence,
  active = EXCLUDED.active;
