-- ============================================================================
-- Migration: 0048_ad_hoc_player_handles
--
-- The back-feed loop for the cold-tail fallback. When a signed-in user marks
-- an identification candidate as 'correct' on a query anchored on an ad-hoc
-- player, we record that confirmation here. The nightly promote-ad-hoc worker
-- (apps/workers/src/identification/promote-ad-hoc.ts) reads:
--
--   SELECT ad_hoc_player_id, COUNT(DISTINCT confirmed_by)
--   FROM ad_hoc_player_handles
--   GROUP BY ad_hoc_player_id
--   HAVING COUNT(DISTINCT confirmed_by) >= 2
--
-- → those ad-hoc rows have been independently confirmed by 2+ users on the
-- same handle and can be promoted ('promotion_status' = 'promoted'), making
-- the (handle, ad_hoc_player_id) link surface in future /scout queries.
--
-- Why a separate table, NOT external_accounts: external_accounts.profile_id
-- is NOT NULL — that schema models a user CLAIMING their own online account
-- against their chessco profile. The ad-hoc back-feed is fundamentally
-- different: signed-in user A confirms that handle H belongs to ad-hoc
-- player P (someone other than A). Schema separation keeps the semantics
-- clean and avoids overloading external_accounts with nullable columns.
--
-- The UNIQUE (ad_hoc_player_id, platform, handle, confirmed_by) constraint
-- ensures one user can't double-count by re-confirming. Distinct count
-- across users is what drives promotion.
-- ============================================================================

CREATE TABLE ad_hoc_player_handles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_hoc_player_id uuid NOT NULL REFERENCES ad_hoc_players(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('lichess', 'chess.com')),
  handle text NOT NULL,
  confirmed_by uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  candidate_id bigint REFERENCES identification_candidates(id) ON DELETE SET NULL,
  confirmed_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (ad_hoc_player_id, platform, handle, confirmed_by)
);

CREATE INDEX ad_hoc_player_handles_ad_hoc_idx
  ON ad_hoc_player_handles (ad_hoc_player_id);
CREATE INDEX ad_hoc_player_handles_handle_idx
  ON ad_hoc_player_handles (platform, handle);

ALTER TABLE ad_hoc_player_handles ENABLE ROW LEVEL SECURITY;

-- Anyone signed in can read back-feed evidence (it's not sensitive). Writes
-- are gated by the API layer (POST /api/candidate/{id}/feedback validates
-- auth + ownership before insert), so we don't need an INSERT policy here.
CREATE POLICY ad_hoc_player_handles_read_authenticated
  ON ad_hoc_player_handles FOR SELECT
  TO authenticated
  USING (true);
