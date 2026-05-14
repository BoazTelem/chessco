-- ============================================================================
-- Allow 'federation-expand' as a platform_players.pulled_via value.
-- ============================================================================
-- The federation-anchored handle-expansion worker (apps/workers/src/
-- identification/federation-expand.ts) inserts discovered Lichess accounts
-- tagged with pulled_via='federation-expand' so they can be distinguished
-- from titled / country / oauth / lazy / inferred sources for downstream
-- analytics + tier seeding. Adds the value to the existing CHECK constraint.
-- ============================================================================

ALTER TABLE platform_players
  DROP CONSTRAINT IF EXISTS platform_players_pulled_via_check;

ALTER TABLE platform_players
  ADD CONSTRAINT platform_players_pulled_via_check
  CHECK (
    pulled_via = ANY (
      ARRAY[
        'titled'::text,
        'country'::text,
        'lazy'::text,
        'self_oauth'::text,
        'inferred'::text,
        'federation-expand'::text
      ]
    )
  );
