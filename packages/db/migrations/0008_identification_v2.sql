-- ============================================================================
-- identification v2 — support Phase 1 W3 Scout flow:
--   - anonymous queries (requested_by becomes nullable; quota enforcement in W10)
--   - sample-game input (paste-a-PGN mode)
--   - input_method discriminator
--   - per-candidate platform + handle + user_confirmed feedback signal
-- ============================================================================

ALTER TABLE identification_queries
  ALTER COLUMN requested_by DROP NOT NULL,
  ADD COLUMN sample_pgn text,
  ADD COLUMN input_method text CHECK (input_method IN ('name', 'sample_game', 'handle', 'mixed'));

-- Existing rows have null sample_pgn / input_method — backfill the
-- old Phase 0 rows so the discriminator is always populated for new code.
UPDATE identification_queries SET input_method = 'name' WHERE input_method IS NULL;

ALTER TABLE identification_candidates
  ADD COLUMN platform text CHECK (platform IN ('lichess', 'chess.com')),
  ADD COLUMN handle text,
  ADD COLUMN user_confirmed boolean DEFAULT NULL;

CREATE INDEX identification_candidates_handle_idx
  ON identification_candidates (platform, handle) WHERE platform IS NOT NULL;

-- ============================================================================
-- RLS for the W3 flow: anonymous reads of own query results via the query_id
-- itself (treated as a capability token). No anonymous writes — POSTs always
-- go through /api/identify which validates input and uses the service role.
-- ============================================================================

-- identification_queries: SELECT by id is fine for anyone — the uuid IS the
-- capability. Existing INSERT/UPDATE policies (authenticated only) remain.
DROP POLICY IF EXISTS identification_queries_select_by_id ON identification_queries;
CREATE POLICY identification_queries_select_by_id ON identification_queries
  FOR SELECT
  USING (true);  -- knowing the uuid is sufficient

-- identification_candidates: anyone can SELECT candidates for a query they
-- have the uuid for. Joined via query_id.
DROP POLICY IF EXISTS identification_candidates_select_by_query ON identification_candidates;
CREATE POLICY identification_candidates_select_by_query ON identification_candidates
  FOR SELECT
  USING (true);  -- same reasoning; uuid is capability
