-- 0033_challenges_no_free_publishing_constraint.sql
--
-- Tighten the DB shape so future Practice challenge rows always represent
-- either cash-funded publishing or credit-funded publishing. Two pre-existing
-- matched beta rows had zero-credit practice funding; the created_at cutoff
-- keeps those rows updatable for settlement while blocking new free rows.

ALTER TABLE challenges
  DROP CONSTRAINT IF EXISTS challenges_funding_shape;

ALTER TABLE challenges
  ADD CONSTRAINT challenges_funding_shape
  CHECK (
    (funding_type = 'cash' AND fee_cents > 0 AND credit_cost = 0)
    OR
    (
      funding_type = 'credits'
      AND fee_cents = 0
      AND (
        credit_cost > 0
        OR created_at < TIMESTAMPTZ '2026-05-14 00:00:00+00'
      )
    )
  );
