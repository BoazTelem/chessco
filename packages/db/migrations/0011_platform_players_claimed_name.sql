-- ============================================================================
-- platform_players.claimed_name — cross-reference handle ↔ federation player
-- ============================================================================
-- When chess.com /pub/player/{u} or Lichess /api/user/{u} returns a real
-- `name` field (or profile.realName), we store it both raw and normalized.
-- Stage 2 then fuzzy-matches the claimed_name against federation_players
-- to detect handles that ARE FIDE-rated but as a DIFFERENT player than
-- our anchor. E.g. chess.com `borisk62` → name "Boris Kantsler" → FIDE
-- 2805359 → NOT Boris Gelfand (FIDE 2805677) → drop from candidates.
-- ============================================================================

ALTER TABLE platform_players
  ADD COLUMN claimed_name text,
  ADD COLUMN claimed_name_normalized text,
  ADD COLUMN claimed_federation_player_id uuid REFERENCES federation_players(id) ON DELETE SET NULL,
  ADD COLUMN claimed_federation_resolved_at timestamptz;

-- Index for fuzzy match in either direction.
CREATE INDEX platform_players_claimed_name_trgm_idx
  ON platform_players USING gin (claimed_name_normalized gin_trgm_ops);
CREATE INDEX platform_players_claimed_fed_idx
  ON platform_players (claimed_federation_player_id) WHERE claimed_federation_player_id IS NOT NULL;

-- Backfill from existing raw payloads (chess.com only — Lichess data
-- stored differently per-probe). The chesscom-titled --enrich path
-- stores { player: {...}, stats: {...} } under raw.
UPDATE platform_players SET
  claimed_name = raw->'player'->>'name',
  claimed_name_normalized = lower(regexp_replace(
    translate(raw->'player'->>'name', 'ÀÁÂÃÄÅàáâãäåÈÉÊËèéêëÌÍÎÏìíîïÒÓÔÕÖòóôõöÙÚÛÜùúûüÑñÇç',
                                       'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuNnCc'),
    '[^a-zA-Z0-9 ]', '', 'g'
  ))
WHERE platform = 'chess.com'
  AND raw ? 'player'
  AND raw->'player'->>'name' IS NOT NULL;
