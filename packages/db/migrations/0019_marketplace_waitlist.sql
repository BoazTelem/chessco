-- ============================================================================
-- Migration: 0019_marketplace_waitlist
-- Phase 1 W1 — homepage exposes three standalone pillars: Scout / Prepare /
-- Practice-from-a-position. The marketplace itself (Feature 3) doesn't ship
-- until Phase 3, so the Practice tile captures interest into this table.
--
-- Inserts allowed from the anon role (anyone can sign up). Reads are
-- admin-only; we expose no public list of waiting emails. Uniqueness on
-- (lower(email), time_class) so a visitor can register interest for multiple
-- time classes but cannot spam the same one.
-- ============================================================================

CREATE TABLE marketplace_waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  time_class text NOT NULL CHECK (time_class IN ('bullet', 'blitz', 'rapid', 'classical', 'any')),
  notes text,
  source text NOT NULL DEFAULT 'home_pillar',
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX marketplace_waitlist_email_class_idx
  ON marketplace_waitlist (lower(email), time_class);

ALTER TABLE marketplace_waitlist ENABLE ROW LEVEL SECURITY;

-- Anyone (including anon) can insert their own row. No SELECT policy —
-- with RLS on and no SELECT policy, the table is effectively read-only
-- to the service role.
CREATE POLICY marketplace_waitlist_insert_public ON marketplace_waitlist
  FOR INSERT
  WITH CHECK (true);

COMMENT ON TABLE marketplace_waitlist IS
  'Email capture from the "Practice from a position" pillar on /. Feature 3 marketplace ships Phase 3; this table notifies signups when it goes live.';
