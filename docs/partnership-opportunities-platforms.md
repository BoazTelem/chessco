# Partnership Opportunities: Lichess & Chess.com

> **Status:** Reference artifact, not actionable today. Maintained as a pitch document for future BD conversations with Lichess and chess.com. The Chessco coverage sprint is currently designed to operate **without** these partnerships (see [`/.claude/plans/do-you-understand-how-refactored-thimble.md`](../.claude/plans/do-you-understand-how-refactored-thimble.md)).

## Why this matters to us

Chessco's matcher links a FIDE-rated tournament player to their online account(s) so we can:

1. **Show opponents how they'll really play** — surface their actual online repertoire as preparation context for an upcoming OTB encounter.
2. **Power paid sparring matchmaking** — verified-identity online matches against the right strength of opponent.
3. **Provide leak analysis on real games** — find a target's positional weaknesses from their public play.

Today our matcher has 47,429 fingerprinted handles (14,884 chess.com + 32,545 Lichess) but only **2.8% of those are linked to a FIDE player** (1,324, all on Lichess). The cap on what we can achieve via independent name-hypothesis discovery is ~5-7% of the full FIDE pool, biased toward the top of the rating distribution.

A partnership with Lichess or chess.com would dramatically expand both coverage and confidence.

## Why this matters to Lichess and chess.com

Chessco generates demand for the partner platform on three dimensions:

1. **Pre-event prep traffic** — Players researching an OTB opponent click through to that player's profile on the partner platform. Free top-of-funnel for the partner.
2. **High-LTV user discovery** — FIDE-rated tournament players are the most engaged, lowest-churn segment. Helping our users find them helps the partner re-engage dormant accounts.
3. **Verified identity provenance** — A "Verified by Chessco / cross-linked to FIDE" badge is a credibility signal that platforms can surface.

## What partnerships unlock

### Lichess partnership

#### A. Authoritative name → handle export

**Today's gap:** Lichess users can set a public "Real name" field on their profile, but there's no bulk export endpoint. We hypothesize handle variants from FIDE names and probe `/api/users` 300 at a time — slow and noisy.

**With partnership:** A read-only delta export of `{handle, real_name, fide_id?, country, title?}` for accounts that have opted to be discoverable. Even a non-personalized federation-anchor list (`{lichess_handle, federation_player_id}` for users who voluntarily federate-link) would close ~80% of our coverage gap in one ingest.

**Coverage impact:** Titled coverage 80% → ~100%, FIDE 2200+ coverage 40% → 80%, FIDE 2000-2199 coverage 15% → 50%.

#### B. Team & club memberships at scale

**Today's gap:** Lichess teams are scattered across `/team/{slug}` HTML — we'd have to scrape. Many federation-affiliated clubs (`FIDE-rated`, `Norwegian Chess Federation`, etc.) carry exactly the linkage we want.

**With partnership:** A `/api/team/{slug}/members` quota that returns 10K-100K members at a time without rate-throttling. We pull each FIDE-affiliated team's roster and cross-match.

**Coverage impact:** Adds ~20-50k more lichess handles with country / federation signal.

#### C. Higher API rate limit / dedicated quota

**Today's gap:** Our fast-lane-lichess hits 429s under any meaningful concurrency. Last bulk run had 57% error rate from rate-limit failures.

**With partnership:** Dedicated quota (e.g. 50 req/sec) keyed to a Chessco API token. Cuts fast-lane wall time from 34h to ~2h.

#### D. Title-change event stream

**Today's gap:** When a player gets a new FIDE title, we have to re-scrape to notice. The platform_players row stays stale.

**With partnership:** Webhook on title changes. Auto-refresh the affected row.

### Chess.com partnership

#### A. Titled-player directory with FIDE_ID linkage

**Today's gap:** `/pub/titled/{TITLE}` returns handles only. We have 16,326 titled chess.com handles but **zero are linked to FIDE entries** because the public directory has no `fide_id` field. Manual reverse-matching via name+country+title trigram is our only option, and it's noisy.

**With partnership:** Add `fide_id` to the public titled directory response (or expose a private export for partners). Chess.com clearly has this linkage internally — they verify titles via FIDE before granting them on the platform.

**Coverage impact:** Closes the **single biggest gap in our current data**. 16,326 chess.com titled handles → instantly linked to ~14-15k FIDE players. Titled coverage jumps to ~95%, FIDE 2200+ coverage to ~70%.

#### B. Higher /pub/player rate limit

**Today's gap:** Our chess.com fed-expand worker runs at 100ms throttle = 10 req/sec. For 73k FIDE 2000+ players × 10 hypotheses (dedupe to ~120k) = ~3.3 hours of continuous run, and chess.com periodically rate-limits us with no advance notice.

**With partnership:** Dedicated quota at 50-100 req/sec. Cuts the run to under an hour.

#### C. Bulk player export for verified accounts

**Today's gap:** Even after we identify a chess.com handle as belonging to FIDE player X, we have to fetch their archive months one-by-one to build a fingerprint. The chess.com Pub API doesn't support bulk export.

**With partnership:** A bulk archive endpoint keyed to verified-Chessco accounts. Cuts per-handle ingest from ~20s to ~2s.

#### D. Player-name search

**Today's gap:** There's no `?q=name` search on the public API. We can only hypothesize handles and probe.

**With partnership:** A search endpoint that returns `{handle, name, country, title}` for fuzzy name matches. Trivially closes 95%+ of the remaining hypothesis-miss gap.

## What we'd offer in exchange

1. **Mutual user growth via Chessco's federated user base** — every Chessco prep report links out to the target's profile on the partner platform with a `?ref=chessco` UTM, sending paying tournament-prep users back to the partner.

2. **Public attribution** — Chessco's `/scout` and `/prepare` UIs visibly credit "Identified via Lichess / chess.com data" wherever a partner-provided signal carried the match.

3. **Verified FIDE→handle pairs for the partner's analytics** — When a Chessco user confirms a name+handle pair (manually claims their own account), we'd export that pair back to the partner. They get verified identity data for free.

4. **Co-marketed event-based features** — World Cup, Candidates, Norway Chess: Chessco's tournament dashboards visibly partnered with the platform of choice for that event.

## Quantified ask summary

| Partner   | Ask                                                 | Coverage impact                 |
| --------- | --------------------------------------------------- | ------------------------------- |
| Lichess   | name→handle export OR fide_id field on user profile | +60-80% Titled, +40% FIDE 2200+ |
| Lichess   | dedicated API quota                                 | 17× faster ingest               |
| Chess.com | fide_id on titled directory                         | +95% Titled in one ingest       |
| Chess.com | dedicated /pub/player rate                          | 5-10× faster ingest             |
| Either    | player-name search endpoint                         | Cuts remaining hypothesis miss  |

## Approach when initiating BD conversations

1. **Open with mutual user growth, not data extraction.** Frame Chessco as a top-of-funnel and re-engagement tool for the partner's high-LTV users.

2. **Don't ask for anything that competes with the partner's business model.** No bulk training data, no anti-abuse signals, no payment data. Just verified identity at the FIDE-anchor end.

3. **Quantify before asking.** Walk in with concrete numbers: "We currently link 1,324 of 553k FIDE players to Lichess accounts via name hypothesis. With your federation-anchor export, we'd reach ~25k overnight."

4. **Start with the smallest viable ask.** Title-change webhook for Lichess, FIDE_ID on titled directory for chess.com. Both are 1-day eng tasks on their side that unlock disproportionate value on ours.

## Open questions for future research

- Does chess.com expose `fide_id` to internal teams? (We assume yes based on title verification flow.)
- Has Lichess ever published a federation-anchor extract for a partner before? (Check `https://lichess.org/api` for undocumented endpoints; check community projects like LichessUserBot, etc.)
- Are there regional federation partnerships (NOR, USA, GER, IND) that bypass the need for direct platform deals?

## Where this work lives

This document is a reference artifact for future BD conversations. The Chessco coverage sprint is designed to operate **without** these partnerships and is the priority path until partner conversations open.

- Sprint plan: [`/.claude/plans/do-you-understand-how-refactored-thimble.md`](../.claude/plans/do-you-understand-how-refactored-thimble.md)
- Sprint commit history: search `git log --oneline --grep="Sprint lever"` from 2026-05-17 onward.
- Coverage measurement: `apps/web/public/coverage-stats.json` (planned, sprint lever 5).
