-- ============================================================================
-- Migration: 0003_rls_and_helpers
-- Phase 0 Week 2 — Row-Level Security on every table per spec §24.
-- Starting position: restrictive by default. Service role (used by workers and
-- privileged server actions) bypasses RLS automatically.
-- ============================================================================

-- Helper: admin check function (used in admin-only RLS policies later).
CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM admin_users WHERE profile_id = auth.uid()
  );
$$;

-- ============================================================================
-- ENABLE RLS ON ALL TABLES
-- ============================================================================

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE federations ENABLE ROW LEVEL SECURITY;
ALTER TABLE federation_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE federation_rating_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE games ENABLE ROW LEVEL SECURITY;
ALTER TABLE positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE moves ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_position_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_opening_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE style_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE identification_queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE identification_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE prep_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_games ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_moves ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE rating_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE refund_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE fairplay_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE fairplay_telemetry ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- POLICIES
-- ============================================================================
-- Convention: service_role bypasses RLS automatically (Supabase default).
-- These policies cover anon and authenticated roles.

-- ----- profiles -----
-- Public select (handle, country, title, etc. are public on opted-in profiles).
CREATE POLICY profiles_select_public ON profiles
  FOR SELECT USING (deleted_at IS NULL);
-- Users can update their own row.
CREATE POLICY profiles_update_own ON profiles
  FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
-- Inserts come via trigger on auth.users; no direct anon/authenticated insert.

-- ----- external_accounts -----
-- Users can read+manage their own external account links.
CREATE POLICY external_accounts_own ON external_accounts
  FOR ALL USING (profile_id = auth.uid()) WITH CHECK (profile_id = auth.uid());
-- Public select on verified accounts (for player profile linking).
CREATE POLICY external_accounts_select_verified ON external_accounts
  FOR SELECT USING (verified = true);

-- ----- verification_tokens -----
-- Users can only see their own pending tokens; never publicly readable.
CREATE POLICY verification_tokens_own ON verification_tokens
  FOR ALL USING (profile_id = auth.uid()) WITH CHECK (profile_id = auth.uid());

-- ----- federations + federation_players + federation_rating_snapshots -----
-- Fully public read. Writes are ingestion-worker-only (service_role bypasses).
CREATE POLICY federations_select_public ON federations FOR SELECT USING (true);
CREATE POLICY federation_players_select_public ON federation_players FOR SELECT USING (true);
CREATE POLICY federation_rating_snapshots_select_public ON federation_rating_snapshots FOR SELECT USING (true);

-- ----- players + player_aliases -----
-- Public read (Scout page browses these). Writes via service role.
CREATE POLICY players_select_public ON players FOR SELECT USING (true);
CREATE POLICY player_aliases_select_public ON player_aliases FOR SELECT USING (true);

-- ----- games + positions + moves -----
-- Public read (prep reports + analysis are public-facing). Writes via service role.
CREATE POLICY games_select_public ON games FOR SELECT USING (true);
CREATE POLICY positions_select_public ON positions FOR SELECT USING (true);
CREATE POLICY moves_select_public ON moves FOR SELECT USING (true);

-- ----- per-player aggregates -----
CREATE POLICY player_position_stats_select_public ON player_position_stats FOR SELECT USING (true);
CREATE POLICY player_opening_stats_select_public ON player_opening_stats FOR SELECT USING (true);
CREATE POLICY style_features_select_public ON style_features FOR SELECT USING (true);

-- ----- identification queries + candidates -----
-- Users can read+create their own queries; results are private to the requester.
CREATE POLICY identification_queries_own ON identification_queries
  FOR ALL USING (requested_by = auth.uid()) WITH CHECK (requested_by = auth.uid());
CREATE POLICY identification_candidates_via_query ON identification_candidates
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM identification_queries q
      WHERE q.id = identification_candidates.query_id
        AND q.requested_by = auth.uid()
    )
  );

-- ----- prep_reports -----
-- Users can read+manage their own reports.
CREATE POLICY prep_reports_own ON prep_reports
  FOR ALL USING (requested_by = auth.uid()) WITH CHECK (requested_by = auth.uid());

-- ----- challenges -----
-- Anyone can see open challenges (the lobby). Creators see all their own.
CREATE POLICY challenges_select_open ON challenges
  FOR SELECT USING (status = 'open' OR creator_id = auth.uid());
-- Creators can insert + update + delete their own challenges.
CREATE POLICY challenges_insert_own ON challenges
  FOR INSERT WITH CHECK (creator_id = auth.uid());
CREATE POLICY challenges_update_own ON challenges
  FOR UPDATE USING (creator_id = auth.uid()) WITH CHECK (creator_id = auth.uid());
CREATE POLICY challenges_delete_own ON challenges
  FOR DELETE USING (creator_id = auth.uid());

-- ----- matches -----
-- Only the two participants (challenge creator + opponent) can read a match.
CREATE POLICY matches_select_participant ON matches
  FOR SELECT USING (
    opponent_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM challenges c
      WHERE c.id = matches.challenge_id AND c.creator_id = auth.uid()
    )
  );
-- Writes via service role only (game server creates matches; no direct user inserts).

-- ----- live_games -----
CREATE POLICY live_games_select_participant ON live_games
  FOR SELECT USING (white_user_id = auth.uid() OR black_user_id = auth.uid());

-- ----- match_moves -----
CREATE POLICY match_moves_select_participant ON match_moves
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM matches m
      LEFT JOIN challenges c ON c.id = m.challenge_id
      WHERE m.id = match_moves.match_id
        AND (m.opponent_id = auth.uid() OR c.creator_id = auth.uid())
    )
  );

-- ----- wallets -----
-- Users see only their own wallet. Writes via service role.
CREATE POLICY wallets_select_own ON wallets
  FOR SELECT USING (profile_id = auth.uid());

-- ----- ledger_entries -----
-- Users see only their own user_wallet entries. Other account types service-role only.
CREATE POLICY ledger_entries_select_own ON ledger_entries
  FOR SELECT USING (account_type = 'user_wallet' AND account_id = auth.uid());

-- ----- stripe_events -----
-- Service role only — no public access. (RLS enabled with no policy = deny all.)

-- ----- ratings -----
-- Public read of skill_rating + trust_tier; users see full row only for self.
CREATE POLICY ratings_select_public ON ratings FOR SELECT USING (true);

-- ----- rating_history -----
CREATE POLICY rating_history_select_own ON rating_history
  FOR SELECT USING (profile_id = auth.uid());

-- ----- refund_requests -----
-- Requester + respondent can see the request. Writes by requester only (inserts).
CREATE POLICY refund_requests_select_participant ON refund_requests
  FOR SELECT USING (requester_id = auth.uid() OR respondent_id = auth.uid());
CREATE POLICY refund_requests_insert_own ON refund_requests
  FOR INSERT WITH CHECK (requester_id = auth.uid());

-- ----- fairplay_flags + fairplay_telemetry -----
-- Subjects can see their own confirmed/dismissed flags (transparency per spec §16
-- `/account/fairplay`). Pending flags are hidden until reviewed.
CREATE POLICY fairplay_flags_select_own_resolved ON fairplay_flags
  FOR SELECT USING (profile_id = auth.uid() AND outcome <> 'pending');
-- Telemetry never readable to end users.

-- ----- audit_logs + admin_users -----
-- No public access. RLS enabled with no policy = service role only.

-- ============================================================================
-- TRIGGER: auto-create profile when a new auth.users row is inserted
-- ============================================================================

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO profiles (id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO wallets (profile_id)
  VALUES (NEW.id)
  ON CONFLICT (profile_id) DO NOTHING;

  INSERT INTO ratings (profile_id)
  VALUES (NEW.id)
  ON CONFLICT (profile_id) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();
