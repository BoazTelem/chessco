# External PGN Auto-Fetch: Closing the Feature 2 Gap

> **Status:** Reference plan, not actively in flight. Captures the design we
> agreed on 2026-05-17 after the two-path account-finder redesign landed.
> Pick this up when the in-flight `chess.com fed-expand` + `fast-lane-lichess`
> backgrounds complete and we have honest baseline numbers to chase against.

## Why this matters

Today Chessco's two-path account finder relies on:

- **Path A — Name search** (Feature 1): matches FIDE-rated players to their
  online accounts via hypothesis + reverse-claim. Reaches ~40% of titled
  players today (target 80%).
- **Path B — Paste PGN** (Feature 2): identifies an account from a few of
  their games via the sparse cascade. Requires the user to supply PGNs.

The gap: for a FIDE-rated player whose online handle is anonymous AND
the user doesn't have ready PGN files, neither path completes without
manual effort. The user has to dig PGNs out of `chessgames.com` or `TWIC`
themselves, then come back and paste them.

**The idea:** once Path A identifies a FIDE player, automatically pull
PGNs of that player from external public databases (ChessBase Online,
chessgames.com, TWIC, etc.), store + fingerprint them, and offer an
"Auto-load opponent's games" button on the Scout result — with explicit
attribution showing where each game came from.

This converts Path A's "found the player but they're anonymous online"
case into a full preparation report without the user lifting a finger.

## Source inventory

| Source                       | Coverage                                                                  | Access                                                                       | ToS posture                                                           | Effort                                         |
| ---------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------- |
| **TWIC (The Week in Chess)** | Weekly tournament dumps, covers all elite + most titled events            | Free zip downloads of `.pgn` files per issue (1,000+ weekly issues archived) | Open re-use with attribution per Mark Crowther's standing policy      | Low (HTTP fetch, no auth, no anti-bot)         |
| **chessgames.com**           | Historical games of ~280k players (legends + active masters)              | HTML player pages, `/perl/chessgame?gid=...` per-game with download button   | Free use with attribution per their site; no API; rate-limit politely | Medium (HTML scrape, has anti-bot if hammered) |
| **365chess.com**             | ~9M games, player pages                                                   | HTML player pages, per-game PGN export                                       | No formal policy; respect robots.txt                                  | Medium (HTML scrape)                           |
| **ChessTempo**               | Player game database with PGN download                                    | Requires login for bulk; per-game PGN is free                                | Free for personal use; bulk requires paid tier                        | Medium-high (auth flow)                        |
| **ChessBase Online**         | Live broadcasts + player profiles via `live.chessbase.com/profile?id=...` | Anti-bot (Cloudflare); Playwright needed                                     | Restrictive ToS — scraping prohibited; need explicit BD conversation  | High (Playwright + cookies)                    |
| **chess-results.com**        | Tournament pairings + games                                               | Per-tournament HTML; anti-bot                                                | Tournament organizer permission expected per ToS                      | High (Playwright)                              |
| **ChessBase MegaBase**       | ~10M curated games                                                        | One-off paid download (~€200)                                                | License permits internal use; redistribution prohibited               | Low ingest, high cost                          |

**Recommended start order (yield per effort):**

1. **TWIC** — open, easy, covers ~95% of elite tournament play. One scraper
   handles 30+ years of weekly issues. Build first.
2. **chessgames.com** — covers historical breadth and ratings 2400+ well.
   Single-source for hard-to-find legacy games.
3. **ChessBase MegaBase** — one-off €200 spend, ~10M games imported in one
   batch. Decide once TWIC + chessgames numbers are in.
4. Defer ChessBase Online + chess-results.com to Phase 2; both need
   Playwright + BD-style negotiation.

## Architecture

### Storage

Add a new table to the games corpus DB:

```sql
CREATE TABLE external_pgn_sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source        text NOT NULL,           -- 'twic', 'chessgames', '365chess', ...
  source_url    text NOT NULL,           -- direct deep-link to the game on the source
  source_event  text,                    -- "FIDE Candidates 2024", "TWIC 1521", ...
  fetched_at    timestamptz NOT NULL DEFAULT NOW(),
  raw_pgn       text NOT NULL,           -- store the raw PGN we downloaded for audit
  game_id       uuid REFERENCES games(id) ON DELETE SET NULL,
  UNIQUE (source, source_url)
);
CREATE INDEX external_pgn_sources_game_id_idx
  ON external_pgn_sources (game_id) WHERE game_id IS NOT NULL;
```

Each parsed external PGN feeds into the existing `games` / `moves` tables
the same way Lichess/chess.com games do, with the addition of an
`external_pgn_sources` row linking back to the source URL for attribution.

### Fingerprinting

The current `account_fingerprints` table is keyed by `(platform, handle)`.
External PGNs belong to a _FIDE player_, not a platform handle. Two options:

1. **Virtual platform**: insert with `platform='fide'`,
   `handle = federation_player_id`. Reuses every downstream feature
   (matcher, leak scorer, /scout result card) without schema changes.
   Display layer translates `fide:<uuid>` back to the player name.
2. **New `fide_player_fingerprints` table** keyed by `federation_player_id`.
   Cleaner conceptually but requires every downstream consumer to handle
   two fingerprint shapes.

**Recommendation: Option 1.** The fingerprint shape is the same regardless
of source; the platform field is just provenance.

### Per-source workers

Each source gets its own worker, all mirroring the existing
`apps/workers/src/lichess-dumps/` pattern:

- `apps/workers/src/external-pgn/twic/run.ts` — iterate TWIC issues, parse
  PGNs, filter by FIDE name match (with the same `pg_trgm` similarity
  used in `reverse-claim`), insert + tag with `source='twic'`.
- `apps/workers/src/external-pgn/chessgames/run.ts` — paginate player
  pages from `chessgames.com/perl/chessplayer?pid=...`, download each
  game, insert.
- Shared lib `apps/workers/src/external-pgn/lib/storage.ts` —
  `insertExternalGame(rawPgn, sourceMeta)`: parse PGN, upsert into
  `games`/`moves`, insert `external_pgn_sources` row, return game_id.
- Shared lib `apps/workers/src/external-pgn/lib/fide-match.ts` —
  resolve a PGN `[White]` / `[Black]` name to a `federation_player_id`
  using the same trigram pipeline as `reverse-claim.ts`. Caches resolved
  names within a run.

### UI surface

On `/scout` and `/scout/match/[query_id]`, when a FIDE player is identified:

- Add a section **"Games we already have"** below the candidate accounts.
- Show count + breakdown by source: _"42 games auto-loaded · TWIC 31,
  chessgames.com 11"_.
- Each source name links to the original URL with a small attribution
  badge ("via TWIC · CC-BY").
- "Open prep" CTA becomes one-click — no PGN paste needed because the
  cascade already has games to match against.

The /benchmarks page gains a third stat under Path A: _"X% of mapped
players have ≥5 games auto-loaded from public sources"_ — closes the
loop on the two-path narrative by showing how often the fast path
delivers a _usable_ result (vs. just an identified handle).

## Phased plan

### Phase 1 — TWIC ingestion (2-3 weeks)

1. Schema migration: add `external_pgn_sources` table.
2. Worker: `external-pgn:twic` — paginate TWIC issues, parse multi-PGN
   files, match `[White]` / `[Black]` to `federation_players`, insert.
3. Backfill: ingest TWIC 1000-1521 in one batch (~520 issues × ~600
   games each = ~310k games covering 2014-2026).
4. Fingerprint pass: run `features:run` with `platform='fide'` filter
   to fingerprint each FIDE player who got ≥10 games.
5. /benchmarks update: render "external coverage" stat.

**Expected yield:** ~15-20k FIDE players (most active masters since 2014)
get auto-loaded fingerprints, regardless of whether they have a
chess.com/lichess account.

### Phase 2 — chessgames.com (2 weeks after Phase 1 lands)

1. Worker: `external-pgn:chessgames` — paginate player pages, throttled
   (3s gap, no concurrency to be polite). Cache resolved FIDE links.
2. Backfill: top 2,000 FIDE-2400+ players by rating.
3. Coverage delta on /benchmarks.

### Phase 3 — ChessBase MegaBase (one-shot, 1 week)

1. €200 license. Decision gate after Phase 1+2 — only spend if the
   yield curve looks worth it.
2. One-shot import script: parse the SCID/PGN export, dedupe against
   what TWIC + chessgames already gave us.

### Phase 4+ — ChessBase Online, chess-results.com

Playwright workstream. Hold until BD conversations open or we accept
the legal posture.

## UI copy / attribution discipline

- Every external-sourced game card shows **"via {source}"** with a link
  to the original page. Non-negotiable for ethical scraping.
- The Scout result page shows the **list of sources we tried** for a
  given player ("TWIC: 31 games · chessgames.com: 11 · not on
  365chess") so the user understands provenance.
- Game export from Scout reports embeds the attribution in PGN tags
  (`[Source "TWIC 1521"]`, `[SourceURL "https://..."]`).
- Right-to-erase: if a FIDE player is on the delist list (Spec §6),
  their external-sourced games are excluded from `/scout` results
  the same way platform games are.

## Out of scope (v1)

- Re-publishing external PGNs as downloadable bundles (would invite ToS
  pushback). We use them to compute fingerprints; the original source
  link remains the canonical place to read the game.
- LLM-driven name disambiguation across sources (memory:
  `two_path_account_search.md` — LLM is fine for ambiguous cases, not
  as a substitute for fingerprint match).
- Tournament-results.com — Playwright + BD work, separate plan.
- Scraping platforms (Lichess / chess.com) themselves — we already have
  those via their public APIs.

## Where this work lives

- Plan: this file (`docs/external-pgn-auto-fetch.md`)
- Architecture sketch: above
- Critical-files inventory below (none yet — all to be created)

### Critical files to create when picked up

- `packages/db/migrations/00XX_external_pgn_sources.sql` — new table
- `apps/workers/src/external-pgn/lib/storage.ts` — shared insert helper
- `apps/workers/src/external-pgn/lib/fide-match.ts` — name → FIDE ID
- `apps/workers/src/external-pgn/twic/run.ts` — TWIC worker (Phase 1)
- `apps/workers/src/external-pgn/chessgames/run.ts` — chessgames worker
  (Phase 2)
- `apps/web/app/scout/match/[query_id]/page.tsx` — render the
  "Games we already have" section above the existing candidates
- `apps/web/app/benchmarks/page.tsx` — third stat under Path A

### Reuse

- `apps/workers/src/identification/reverse-claim.ts` — trigram pipeline
  for matching PGN `[White]` / `[Black]` to `federation_players` is the
  same logic.
- `apps/workers/src/features/extract.ts` — existing feature extractor
  works on any PGN regardless of source.
- `apps/workers/src/stage3/match.ts` — sparse cascade works on any
  fingerprint, virtual or platform.

## Open questions for future research

- TWIC includes some games of titled players who never play online — does
  this materially improve Feature 2 accuracy on FIDE 2200+ vs. our
  current Lichess/chess.com-only corpus?
- ChessBase Online has _unique_ live-event coverage (e.g. Norway Chess
  rapid). Worth the BD push, or does TWIC catch it within the week?
- Is there a public dataset that already aggregates these sources (e.g.
  the OlimpBase Federation Records archive)? Could shortcut Phase 1 if so.
