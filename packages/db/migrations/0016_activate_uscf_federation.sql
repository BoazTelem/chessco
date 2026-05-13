-- ============================================================================
-- Migration: 0016_activate_uscf_federation
-- Phase 0 Week 7 — flips USCF to active=true and updates the rating_list_url
-- to the public top-players page (the path the Playwright worker scrapes).
-- Cron schedule lives in apps/workers/src/inngest/federations.ts (cron
-- "0 6 7 * *") and is documented in docs/PLAN.md "Federation cron registry".
-- ============================================================================

UPDATE federations
SET
  rating_list_url = 'https://new.uschess.org/top-players',
  rating_list_format = 'html',
  sync_cadence = 'monthly',
  active = true
WHERE id = 'USCF';
