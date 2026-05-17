-- ============================================================================
-- Migration: 0049_platform_players_claimed_fide
--
-- Capture self-reported FIDE rating + country from chess.com and Lichess
-- public profiles. Both platforms let players type a FIDE rating into their
-- bio; chess.com /pub/player exposes it as `fide` (integer) and Lichess
-- /api/user/{u} exposes it as `profile.fideRating`. Both expose country
-- (chess.com via .country URL → ISO, Lichess via profile.country ISO2).
--
-- Why: Stage 2 candidate scoring leans heavily on FIDE-vs-online rating
-- proximity. Today we only have the candidate's online ratings (bullet/
-- blitz/rapid/classical) and compare to the anchor's FIDE rating with a
-- ±400 / +150 offset heuristic. If the candidate themselves SAYS their
-- FIDE rating is 2150 in their bio, that's a sharper signal than any
-- inferred offset — when present, it should dominate the rating component.
--
-- Plan note: the original plan also mentioned `claimed_fide_id`. Neither
-- API actually exposes the FIDE ID number — only the rating. We model
-- only what's actually retrievable; FIDE-ID-↔-handle linkage comes from
-- chess-results.com remarks (Workstream B.3) and Lichess Broadcast PGNs
-- (Workstream B.1), not from platform self-reports.
--
-- claimed_country is added alongside the existing `country` column rather
-- than overwriting it because:
--   - `country` is the canonical/crawler-derived country (e.g. country
--     directory ingestion writes this).
--   - `claimed_country` is what the player self-reported in their bio.
--   Disagreement is itself an interesting signal we want to preserve.
-- ============================================================================

ALTER TABLE platform_players
  ADD COLUMN claimed_fide_rating int,
  ADD COLUMN claimed_country text;

-- Sparse index — most rows won't have a claimed_fide_rating, so a partial
-- index keeps it small while still serving "give me handles claiming FIDE
-- > 2000" queries from Stage 2 / the rating-band-tightening rerank.
CREATE INDEX platform_players_claimed_fide_rating_idx
  ON platform_players (claimed_fide_rating)
  WHERE claimed_fide_rating IS NOT NULL;

-- Backfill from raw blobs we already have. chess.com path: raw.player.fide
-- (integer). Lichess path: raw.profile.fideRating. Use jsonb operators
-- so missing keys silently produce NULL.
UPDATE platform_players SET
  claimed_fide_rating = NULLIF(raw->'player'->>'fide', '')::int
WHERE platform = 'chess.com'
  AND raw ? 'player'
  AND raw->'player' ? 'fide'
  AND claimed_fide_rating IS NULL;

UPDATE platform_players SET
  claimed_fide_rating = NULLIF(raw->'profile'->>'fideRating', '')::int
WHERE platform = 'lichess'
  AND raw ? 'profile'
  AND raw->'profile' ? 'fideRating'
  AND claimed_fide_rating IS NULL;

-- Country backfill — chess.com `country` is a URL; lichess `profile.country` is ISO2.
UPDATE platform_players SET
  claimed_country = regexp_replace(raw->'player'->>'country', '.*/', '')
WHERE platform = 'chess.com'
  AND raw ? 'player'
  AND raw->'player' ? 'country'
  AND claimed_country IS NULL;

UPDATE platform_players SET
  claimed_country = raw->'profile'->>'country'
WHERE platform = 'lichess'
  AND raw ? 'profile'
  AND raw->'profile' ? 'country'
  AND claimed_country IS NULL;
