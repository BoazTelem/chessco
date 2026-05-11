# Chessco — Phased Build Plan

**Domain:** chessco.org • **Slogan:** _Scout. Prepare. Win._ • **Spec:** [chessco-full-spec.md v1.1](chessco-full-spec.md) (2026-05-11)

---

## Context

Chessco is a chess preparation and sparring platform with three integrated capabilities:

1. **Player discovery** — name-anchored identification: search official OTB rating lists (FIDE, USCF, national federations) first, then match to online Lichess / chess.com accounts. Style fingerprint is a verifier, not the primary search axis.
2. **Opponent preparation** — per-opponent battle plans showing repertoire, leaks, and exploitable lines vs. the user's own play.
3. **Paid sparring marketplace** — publish a starting position and pay a fixed fee per game; verified human opponents play it with you, paid for completing the session.

This plan executes the build from zero to revenue, mapped to spec v1.1. The architectural change from v1.0 → v1.1 (name-anchored over style-anchored, validated by SnoopChess's product) reorders the phases: FIDE ingestion ships in Phase 0, identification + prep ship together in Phase 1, and embeddings move to Phase 2.

**Why now:** Lichess/chess.com have games but no prep tools. ChessBase has prep tools but is desktop-only, $300+, master-level. SnoopChess does player discovery only. No one ties discovery → prep → practice → paid sparring into a single loop. That's the gap, and the integrated loop (Scout → Find → Practice → Pay → Improve) is the moat.

---

## Current Status (2026-05-11)

- ✅ **Phase 0 Week 1 — Monorepo scaffold complete.** Next.js 15 + 6 shared packages, brand tokens, dark-mode default, GitHub Actions CI (build/typecheck/lint/format all green). Three commits on `main`: plan, spec v1.1, scaffold.
- 🔄 **Provisioning external services — in progress.** Vercel + Supabase (prod + staging) are being set up. See [`SETUP.md`](SETUP.md) for the actionable checklist. Sentry and PostHog deferred to Phase 0 Week 7 polish.
- ⏭ **Next code work — Phase 0 Week 2 — Drizzle schema.** Cannot land in prod until Supabase projects exist and credentials are in Vercel. Schema can be drafted locally in parallel; final migration applied to `chessco-staging` first, then `chessco-prod`.

---

## Locked Decisions

| Decision                | Value                                                               | Why                                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name + domain + slogan  | Chessco / chessco.org / _Scout. Prepare. Win._                      | Locked in v1.1. `.com` acquisition still open (§27).                                                                                                                                    |
| Marketplace take rate   | **15% gross**                                                       | Covers Stripe (~3%) + engine compute + AI + ops; matches spec §13. Pricing displayed as "you pay $X.00, opponent receives $0.85·X" per spec.                                            |
| Game server             | **Fly.io** (dedicated Node WebSocket)                               | Vercel serverless can't hold long-lived WebSockets or run authoritative clocks. Fly Frankfurt/Amsterdam for EU/IL launch.                                                               |
| Payout framing          | **Completion-based**                                                | Opponent paid for playing the position to a natural conclusion regardless of result. Keeps platform out of gambling regulation. Forbidden vocabulary list (§3) enforced in copy review. |
| Identification approach | **Name-anchored**, three-stage (anchor → handle → style verifier)   | Per spec §6 v1.1. FIDE is the canonical anchor. Style embedding moves to Phase 2.                                                                                                       |
| Marketplace copy rule   | "Win" not allowed within two screens of any fee/payout amount       | Per spec §17 v1.1. Marketplace surfaces use sub-tagline _"Practice the positions that matter"_. Protects legal framing.                                                                 |
| Marketplace pricing     | $0.50 bullet / $1 blitz / $2 rapid / $5 classical (default ladders) | _Default_ fee suggestions in `/challenges/new`; creator can override within bounds.                                                                                                     |
| Plan depth              | All 7 phases, week-by-week                                          | Per user request — full handover plan.                                                                                                                                                  |

---

## Tech Stack (locked)

**Frontend:** Next.js 15 (App Router, strict TS) on Vercel • Tailwind + shadcn/ui • TanStack Query + Zustand + RHF/Zod • `react-chessboard` → Chessground later • `chess.js` • Stockfish WASM in browser
**Backend:** Supabase (Postgres + Auth + Storage + Realtime + pgvector + pg_trgm) • Drizzle ORM • Inngest workers • Upstash Redis • Stockfish on Cloud Run • Anthropic Claude (Opus/Sonnet/Haiku per §15) • Resend + Loops • Sentry + PostHog + BetterStack
**Game server:** Fly.io (Node 20 + `ws`), match state in memory + Redis checkpoint
**Payments:** Stripe Connect Express (MCC 8299 services marketplace — NOT a 79xx gaming code)

---

## Repository Layout

```
chessco/
├── apps/
│   ├── web/                 # Next.js — marketing + app + admin
│   ├── gameserver/          # Node WebSocket server (Fly.io)
│   └── workers/             # Inngest functions (FIDE ingest, PGN import, Stockfish batch, AI reports)
├── packages/
│   ├── db/                  # Drizzle schema + migrations
│   ├── types/               # Shared TS types
│   ├── chess-core/          # PGN/FEN/engine helpers
│   ├── ai/                  # Versioned Claude prompts + helpers
│   ├── ui/                  # shadcn components + theme + brand tokens
│   └── analytics/           # Event tracking helpers
├── content/                 # MDX: blog/, kb/, legal/
├── ops/                     # runbooks/, prompts/, sql/
└── .github/workflows/
```

Tooling: pnpm + Turborepo, TS strict, ESLint + Prettier + Husky + lint-staged, Vitest (unit) + Playwright (E2E), Drizzle migrations, GitHub Actions CI. (Phase 0 Week 1 — already shipped.)

---

## Phase 0 — Foundation (5–7 weeks)

**Goal:** A user can sign up, link Lichess/chess.com, see their own games, and search the federation player database.

| Week | Deliverables                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | ✅ Monorepo (`pnpm` + Turbo), Vercel project, Supabase project (prod + staging), GH Actions CI, env management, Sentry + PostHog wired. Brand tokens in `packages/ui` (slate primary + amber accent, Inter + Geist fonts, dark-mode default).                                                                                                                                                |
| 2    | **Full DB schema migrated** (all tables from spec §5 v1.1 — including `federations`, `federation_players`, `federation_rating_snapshots`, `identification_queries`, `identification_candidates`). RLS policies on every table. pgvector + pg_trgm extensions enabled. GIN trigram index on `federation_players.name_normalized`. `games` partitioned by `played_at` month. Critical indexes. |
| 3    | Supabase Auth (email/password + magic link + Google OAuth + Apple OAuth). Onboarding wizard (country, DOB ≥18 gate for paid features, marketing consent). App shell with sidebar nav + dark mode.                                                                                                                                                                                            |
| 4    | Lichess OAuth integration (verified account linking). Chess.com bio-token verification flow (`verification_tokens` table). External account display on profile.                                                                                                                                                                                                                              |
| 5    | **FIDE ratings ingestion worker** (Inngest, monthly cron `0 4 5 * *` + manual trigger). Stream-parse XML, batch upsert 1000 rows at a time, write `federation_rating_snapshots` for ratings/title changes. Implementation per [`fide-ingestion-spec.md`](fide-ingestion-spec.md). USCF top-list ingest if scope allows; else slip to Phase 1.                                                |
| 6    | PGN import worker (Inngest) — pull last 200 games from each linked Lichess/chess.com account, parse, intern positions, write `games` + `moves`. Backfill `external_accounts.rating_*` fields. Federation search MVP at `/scout` — trigram-fuzzy name + country/title/rating filters against `federation_players`.                                                                            |
| 7    | `/dashboard` with own games list + linked accounts, `/account` for profile + linked accounts management, `/p/[player_id]` basic federation player profile (name, country, title, rating chart from snapshots), marketing site placeholder home page, deployment hardening, Phase 0 retro.                                                                                                    |

**Exit criteria:**

- A non-engineer can sign up, link Lichess, and see their last 200 games rendered as cards within 90 seconds.
- FIDE ingestion has run successfully and `federation_players` has ~400k rows.
- `/scout` returns Magnus Carlsen as top hit for query "magnus carlsen" in <100ms.
- Schema deployed in prod. Zero Sentry errors in a clean signup→link→view flow.

**Out of scope:** prep reports, online-account matching, marketplace, payments.

**Why FIDE first.** Federation rating list is the canonical anchor for all of Feature 1. Small (~400k records), structured, free, monthly cadence. Without it, the system has no way to ground "real-world player" → "online account" matches.

---

## Phase 1 — Identification + Opponent Prep MVP (8–10 weeks)

**Goal:** A user can find a public chess player by name/country and get a usable battle plan against them. Ships as a paid product (subscription gate) to validate willingness to pay before building the marketplace.

| Week | Deliverables                                                                                                                                                                                                                                                                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **Lichess monthly DB dump ingestion** (Inngest worker) — filter rated games ≥ 1500 in last 24 months, parse with `pgn-extract` or `python-chess`, dedupe via `(source, source_game_id)`, write to partitioned `games`. Token-bucket rate limiter (60/min Lichess) for live API.                                                                      |
| 2    | Chess.com PubAPI on-demand fetcher with 7-day cache. Per-player monthly archive fetch, parse, write to `games`. Token-bucket rate limiter (30/min chess.com).                                                                                                                                                                                        |
| 3    | **Stage 2 matching pipeline** (online accounts per federation anchor) — fuzzy handle search via pg_trgm on `external_accounts.handle`, country filter, rating-band correlation (online blitz/rapid within ±300 of FIDE standard). Up to 10 candidate handles per anchor.                                                                             |
| 4    | **Stockfish workers on Cloud Run** (autoscaling, depth 18 default, 25 for critical positions). Batch analysis: given a `game_id`, populate `moves.eval_*` and `cp_loss`, mark blunders/mistakes/inaccuracies.                                                                                                                                        |
| 5    | **Stage 3 stylometric verification** (engineered features only; embedding training deferred to Phase 2). Compute repertoire histogram, avg cp loss by phase, time-curve, etc. on the fly for top candidates. Compute combined ranking score per spec §6. Persist results in `identification_queries` + `identification_candidates`.                  |
| 6    | Per-player aggregates — `player_position_stats` + `player_opening_stats` materialized via incremental jobs. Tier A/B/C storage strategy enforced (§6). Opening tree builder.                                                                                                                                                                         |
| 7    | **Leak detection** algorithm per spec §7 step 2 (reachability + frequency + score gap + cp loss + user familiarity → severity score). Recommended-line walker (2–4 sequences per leak, annotated with engine eval + master frequency). Practice-position selector.                                                                                   |
| 8    | Claude prompt library (`packages/ai/prompts/prep_summary_v1.md`, `evidence_v1.md`, `style_fingerprint_v1.md`) — coach not analyst, no inventing moves, structured JSON input. Wire Opus for summaries, Sonnet for risk paragraphs, Haiku for evidence prose. Versioned prompts + eval harness.                                                       |
| 9    | `/reports/new`, `/reports`, `/reports/[id]` UI — interactive viewer with collapsible sections, embedded boards on recommended lines. PDF export via Playwright HTML→PDF, stored in Supabase Storage with signed URLs. PGN export of all recommended lines. `/scout` result cards now show online-account match confidence + "Build prep report" CTA. |
| 10   | **Stripe Billing subscription** (simpler than Connect — subscription only at this phase). Subscription gate on full report; preview for free. 30-day report cache + on-demand refresh for subscribers. Phase 1 retro + soft launch to paid waitlist.                                                                                                 |

**Exit criteria:**

- Identification engine returns correct top-1 online account ≥75% on a labeled 100-query eval set (federation-anchored queries only).
- Generate a prep report for a real Lichess player in <90 seconds.
- PDF + PGN exports work; PGN imports cleanly into Lichess studies and chess.com analysis.
- Subscription paywall live and tested with Stripe test mode + real card.

---

## Phase 2 — Identification Depth (6–8 weeks)

**Goal:** Identification works against partially anonymous online accounts, not just OTB-anchored players. Style fingerprint becomes a real verifier and an explorer.

| Week | Deliverables                                                                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | **Engineered feature extractor** at scale — 200–500 named features per player from their game corpus. Write to `style_features.features`. Backfill for Tier A/B players.                                                                                           |
| 2    | Feature normalization + float vector projection for fast comparison.                                                                                                                                                                                               |
| 3–4  | **Embedding model training** (offline) — small transformer encoder over game-feature sequences, contrastive loss (same-player batches close, diff-player far). 384-dim output. Training pipeline + model versioning in `ops/models/`. Eval on held-out player set. |
| 5    | Inference path — encode any player's recent games to embedding, write to `players.embedding`. Schedule weekly recomputation. **pgvector HNSW index** on `players.embedding`.                                                                                       |
| 6    | Stylometric verification integrated into Stage 3 ranking. "Find unrated lookalikes" — given an anchor, find similar online accounts that may belong to the same person. Cross-platform sibling-account consistency check.                                          |
| 7    | Style fingerprint UX polish — radar chart on 8 axes, prose summary via Haiku, sample-game upload to compare your style to a target. `/scout/federation/{id}` ranked-list browse mode (SEO + discovery).                                                            |
| 8    | **Privacy & ethics enforcement** in product — anonymous accounts off by default, opt-in toggle in `/account`, right-to-delist endpoint, doxxing-prevention copy review. Federation rating data hide-from-search on request. Phase 2 retro.                         |

**Exit criteria:**

- Identification engine returns correct top-1 candidate ≥80% on a labeled eval set of 100 mixed queries (including some anonymous-only ones).
- "Find lookalikes" surfaces plausible matches for known multi-account users in internal testing.
- Right-to-delist removes player from index within 5 minutes.

---

## Phase 3 — Marketplace MVP, No Real Money (8–10 weeks)

**Goal:** Internal users publish challenges and play them end-to-end on the live game server. Telemetry lit up. **No payments yet.**

| Week | Deliverables                                                                                                                                                                                                                                                                                                                                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–2  | **Fly.io game server scaffold** — Node 20 + `ws`, single-region deploy (Frankfurt). JWT auth from web app. Match state in memory + every-move Redis checkpoint. Multi-instance with sticky match routing.                                                                                                                                                                                                  |
| 3    | WebSocket protocol per spec §14 — message types (hello, move, resign, draw, chat, report, ping; state, move_accepted/rejected, opponent_move, opponent_disconnected/reconnected, game_end, draw_offered/declined, pong, error).                                                                                                                                                                            |
| 4    | **Server-authoritative clocks** — server decrements moving player's clock by `(server_received_at − server_last_move_at)`. Every 1s broadcast for client resync. Move validation via `chess.js` server-side.                                                                                                                                                                                               |
| 5    | Disconnect handling — 60s grace, clock keeps ticking. Asymmetric abandonment rule (opponent abandons → no payout + full refund; creator abandons → opponent still paid). Persist final state to `live_games`.                                                                                                                                                                                              |
| 6    | `/challenges/new` — FEN editor (drag pieces, paste FEN, import from game), live engine eval, time control dropdown, rating band, fee, games-requested, trust requirement, notes. Validations per spec §8 (legal FEN, eval bounded \|±5\|, wallet check, jurisdiction). **Marketplace copy uses sub-tagline "Practice the positions that matter" — "Win" banned within two screens of fee/payout amounts.** |
| 7    | `/challenges` lobby with Supabase Realtime live updates, filter chips, accept flow with confirmation modal. State transitions `open → matched → starting → live → completed`.                                                                                                                                                                                                                              |
| 8    | `/game/[match_id]` live room — board, clocks, chat, draw/resign/report buttons. `/matches` list. `/matches/[id]` post-game review with engine analysis.                                                                                                                                                                                                                                                    |
| 9    | **Anti-cheat telemetry collection** (passive) — `fairplay_telemetry` writes for `tab_blur`, `tab_focus`, `mouse_idle`, `paste_detected`, `devtools_open`. Move time vs. complexity logged. No actions taken yet — data only.                                                                                                                                                                               |
| 10   | Internal QA with 20+ test users playing real games. Phase 3 retro.                                                                                                                                                                                                                                                                                                                                         |

**Exit criteria:** Two internal users can publish + accept + play a full game on Fly.io with no desync, server-authoritative clocks holding under load. Telemetry rows populating. Post-game review accurate.

---

## Phase 4 — Real Payments & Marketplace Launch (6–8 weeks)

**Goal:** Marketplace goes live with real money in IL + EU + UK + CA + AU per §3.

| Week | Deliverables                                                                                                                                                                                                                                                                        |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **Stripe Connect Express** integration — onboarding redirect, capabilities `transfers` + `card_payments`, webhooks (`account.updated`, `transfer.created`, `payout.paid`, `payout.failed`, `charge.dispute.created`). MCC 8299 application coordinated with Stripe contact (Mitch). |
| 2    | **Double-entry ledger** — `ledger_entries` writes for every $ movement (deposit, escrow, payout, platform fee, withdrawal, refund). Daily reconciliation job: `sum(escrow) == sum(wallets.pending_cents)`.                                                                          |
| 3    | Wallet UI — `/account/wallet` with balance, transaction history, deposit (Stripe Checkout), withdrawal. Pre-checks: KYC complete, balance sufficient, not under fairplay hold. Hold periods per trust tier (New/Bronze T+5d, Silver T+3d, Gold T+1d, Platinum T+0).                 |
| 4    | **Escrow flow integrated with match lifecycle** — on accept: debit creator wallet → escrow; on settle: split escrow → platform_revenue (15%) + opponent wallet (85%). Match state machine `accepted → starting → live → completed → settled` with 24h review window.                |
| 5    | **Glicko-2 rating** implementation — separate ratings per time class, Bayesian prior from external account ratings, rating_history audit trail. Provisional badge when RD>100.                                                                                                      |
| 6    | **Trust score** implementation per spec §10. Tier thresholds gate publish/accept caps. Decay rules (1pt/week after 90d inactive).                                                                                                                                                   |
| 7    | **Refund system** — categorical reason codes only (no free-text bypass), auto-resolution rules (opponent_abandoned + telemetry confirms → auto-approve; opponent_didnt_play_position + FEN mismatch → auto-approve). Admin queue at `/admin/refunds`.                               |
| 8    | **Geo-blocking** at marketplace surface (IP geolocation): allow IL/EU/UK/CA/AU; block IN/SA/AE for paid features; defer US state-by-state. **Legal review sign-off** required before launch. Phase 4 retro + soft launch.                                                           |

**Exit criteria:** Written legal opinion confirming non-gambling classification in launch jurisdictions. First 50 real-money matches completed and settled cleanly. Daily reconciliation passes 7 consecutive days. Zero stuck-escrow incidents.

---

## Phase 5 — Anti-Cheat & Trust Hardening (6–8 weeks)

**Goal:** Platform is trustworthy enough for higher-volume paid play.

| Week | Deliverables                                                                                                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–2  | **Post-game engine correlation** — re-analyze paid games at depths 12/18/25, compute engine match rate, compare against rating-appropriate baseline. Outlier detection writes `fairplay_flags`. |
| 3    | **Move time vs. complexity analyzer** — complexity score per position from engine workers; flag inverted thinking patterns.                                                                     |
| 4    | **Sandbagging detection** — new-account fast-rise + rating-platform discrepancy → review queue. Rating-band stretching capped at 1.5× external rating.                                          |
| 5    | `/admin/fairplay` queue — severity-sorted, with engine correlation chart, telemetry replay, game replay. Decision UI (confirm/dismiss + notes). Audit logged.                                   |
| 6    | Action stack per spec §12 (severity 1 log → 6+ permanent paid-play ban + payout forfeit). Hard KYC gate ≥$20 cumulative earnings; $50 cap without KYC.                                          |
| 7    | Player report button in game room + post-game. Reporter trust +1 if confirmed. Public ban list (opt-in transparency).                                                                           |
| 8    | Annual fair-play transparency report template. Phase 5 retro.                                                                                                                                   |

**Exit criteria:** Fairplay queue SLA <72h. False-positive rate <2% on confirmed-cheater eval set. Zero settled payouts to users with confirmed cheating in 30 days post-launch.

---

## Phase 6 — Style-Mimicking Bots & Coach Features (8–10 weeks)

**Goal:** Differentiated practice features that don't require paid opponents.

| Week | Deliverables                                                                                                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–3  | **Maia fine-tuning pipeline** — per-player model fine-tunes (offline job, hours per model), bot weights stored in Supabase Storage. Inference service hosted as a separate Cloud Run worker. |
| 4–5  | `/practice` drill mode — practice each recommended line from a prep report against the opponent's style bot. Subscription-gated.                                                             |
| 6    | Full-game sandbox vs. opponent-style bot.                                                                                                                                                    |
| 7    | Spectator mode — read-only WebSocket subscribers with 10-move delay (anti-coaching); verified silver+ get no-delay.                                                                          |
| 8–9  | **Coach accounts** — multi-student dashboards, assign prep reports to students, view student game history. New `coach_students` join table.                                                  |
| 10   | OTB tournament prep mode — FIDE ID integration, pre-tournament report bundle (build prep on all known pairings). Phase 6 retro.                                                              |

**Exit criteria:** Maia bots playable end-to-end. Coach accounts in use by ≥10 paying coaches.

---

## Phase 7+ — Scale, Internationalization, Ecosystem (ongoing)

- Localized UI (Hebrew, Spanish, German, French, Russian) — Next.js i18n routing
- Mobile app (React Native, shared logic via packages/)
- Tournament partnerships (federation deals)
- Streaming integrations (Twitch/YouTube overlay showing live prep cards)
- Public API for chess content creators
- US state-by-state legal expansion
- Bug bounty program (HackerOne) once volume justifies

---

## Marketing Site, Blog, KB, Legal (parallel to Phases 1–4)

These do not block engineering phases but must be in flight:

- **Marketing site** (`/`, `/how-it-works`, `/pricing`, `/scout-preview`, `/for-coaches`, `/for-tournament-players`, `/about`, `/contact`) — built incrementally Phase 1 onward. Target Lighthouse ≥95 mobile/desktop, LCP <2s, fully SSG. Voice: direct/professional, banned vocab per §3 and §17. **Marketplace surfaces** (`/challenges`, `/challenges/new`, `/game/*`, `/account/wallet`) **use the sub-tagline "Practice the positions that matter" — "Win" cannot appear within two viewport-screens of any fee/payout amount** (spec §17).
- **Blog** (`content/blog/*.mdx`) — 2 articles/week for 6 months starting Phase 1 = 48 articles to build SEO base. Claude Sonnet first drafts, human-edited.
- **Knowledge base** (`content/kb/*.mdx`) — seed articles from §19 list, client-side search (Pagefind), in-app `?` links.
- **Legal pages** (`content/legal/*.mdx`) — Terms, Privacy (GDPR+CCPA), Refunds, Fair Play, Acceptable Use, Cookies, DPA. Draft by Boaz (existing GDPR DPA v4 template as base), counsel review before Phase 4 launch.

---

## Critical Files to Establish Early

These files are referenced by many later phases; get them right in Phase 0:

| Path                                 | Purpose                                                                                               |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `packages/db/schema.ts`              | Drizzle schema — single source of truth for all tables in spec §5 (including federation tables)       |
| `packages/db/migrations/`            | Drizzle migrations, applied in CI to Supabase                                                         |
| `packages/types/index.ts`            | Shared TS types (Match, Challenge, PrepReport, FederationPlayer, IdentificationCandidate, etc.)       |
| `packages/chess-core/`               | PGN parser, FEN helpers, position interning, eval helpers, **name normalizer** (used by FIDE ingest)  |
| `packages/ai/prompts/`               | Versioned Claude prompts — `prep_summary_v1.md`, `evidence_v1.md`, `style_fingerprint_v1.md`          |
| `packages/ui/theme.ts`               | Brand tokens — slate primary, amber accent, Inter + Geist fonts, **master + marketplace sub-tagline** |
| `apps/web/middleware.ts`             | Geo-blocking + jurisdiction routing                                                                   |
| `apps/workers/src/fide-ingestion.ts` | FIDE monthly cron — see [fide-ingestion-spec.md](fide-ingestion-spec.md)                              |
| `apps/gameserver/src/match.ts`       | Authoritative match state machine                                                                     |
| `ops/runbooks/fide-ingestion.md`     | First runbook — required before Phase 0 close                                                         |
| `ops/runbooks/`                      | Operational runbooks — required before Phase 4 launch                                                 |

---

## Verification (end-to-end at each phase gate)

**Phase 0 gate:**

- Manual: signup → link Lichess → see games. ≤90s.
- Manual: `/scout` for "magnus carlsen" returns Carlsen in <100ms.
- Automated: Playwright E2E covers signup, OAuth callback, dashboard render, scout search.
- DB: RLS proven by attempting cross-user row read (must fail). `federation_players` row count within 1% of FIDE published totals.

**Phase 1 gate:**

- Eval: identification top-1 accuracy ≥75% on 100-query labeled set (federation-anchored).
- Manual: generate prep report on a known Lichess player; PDF downloads; PGN imports cleanly into Lichess studies.
- Stripe: subscription checkout → access unlocked within 5s.

**Phase 2 gate:**

- Eval: identification top-1 accuracy ≥80% on mixed 100-query set including anonymous-only queries.
- Manual: "find lookalikes" returns plausible matches for known multi-account users.
- Privacy: right-to-delist removes player from index within 5min.

**Phase 3 gate:**

- 20 internal users complete 50+ games without clock desync.
- Telemetry rows populating; no missing data on any completed match.
- Copy audit: zero instances of "win"/"won"/"winner" within two screens of any fee or payout amount on marketplace pages.

**Phase 4 gate:**

- Legal opinion in hand, signed.
- 7-day clean reconciliation (`escrow == sum(pending_cents)`).
- 50 real-money matches settled.
- Refund auto-resolution rate ≥60% on opponent_abandoned cases.

**Phase 5 gate:**

- Fairplay queue median resolution <48h.
- False-positive rate <2% on 50-case eval set.

**Phase 6 gate:**

- 10+ coaches using coach accounts.
- Maia bots playable; user-reported "feels like the real player" ≥3.5/5 in survey.

---

## Open Decisions (to lock during build, do not block start)

These are deferred to Boaz; the plan accommodates either resolution:

1. **Subscription pricing & tiers** — lock by Phase 1 week 8 (before subscription checkout ships). Suggest 3 tiers: Free (limited search, preview reports) / Solo $19/mo (unlimited reports, marketplace publish) / Pro $39/mo (priority queue + coach features).
2. **Trademark + .com acquisition** — name/domain/slogan locked; trademark search and chessco.com acquisition remain open.
3. **Entity structure** — separate company vs Foto Master subsidiary. Lock before Stripe MCC application (Phase 4 week 1).
4. **Co-founders / hiring** — solo or recruit CTO. Affects timeline ±50%.
5. **Funding** — bootstrap, pre-seed, or SAFE round. Lock before Phase 2 (vector model training + ingestion costs grow).
6. **Brand voice intensity** — direct/intense (Whoop-style) vs friendly/aspirational (Lichess-style). Lock before marketing site copy (Phase 1).
7. **Coach accounts timing** — Phase 1 or Phase 6+. Plan slots them in Phase 6.
8. **OTB / FIDE focus depth** — currently anchored in Phase 0–1. Whether to expand to ECF, DSB, etc. in Phase 2 or wait for launch demand.
9. **AI redundancy** — Anthropic-only or also OpenAI fallback. Plan is Anthropic-only.

---

## Risk Mitigations (top 6 from spec §26)

| Risk                                               | Mitigation in this plan                                                                                                                                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gambling regulation                                | Completion-based payout enforced from copy through DB schema (no result-conditional payout fields). Marketplace copy rule (§17) enforced as Phase 3 gate. Legal review hard gate before Phase 4 launch. Geo-block India/SA/UAE for paid features. |
| Engine cheating destroys trust                     | Multi-layer anti-cheat from Phase 3 (telemetry) and Phase 5 (correlation + actions). KYC + linked-account requirements for paid play. Hold periods cover refund window.                                                                           |
| Stripe rejects platform classification             | MCC 8299 services-marketplace, NOT 79xx gaming. Mitch (Stripe contact) involved before Phase 4 week 1. Backup: Adyen or Checkout.com.                                                                                                             |
| Player ID doxxing / privacy complaint              | OTB-rated players default-public; anonymous online accounts off by default; no reverse-lookup; right-to-delist endpoint shipping Phase 2 week 8.                                                                                                  |
| Low marketplace liquidity                          | Seed budget for FM/IM contractor sparring partners ($500–2k/mo for first 6mo post Phase 4). Subsidize early payouts via temporary 0% take rate during soft launch.                                                                                |
| Storage scale (games corpus) exceeds Supabase tier | Partition `games` by month from day one (Phase 0 Week 2). Plan to split corpus to dedicated Postgres if Supabase tier insufficient post-Phase 1 ingest.                                                                                           |

---

## Estimated Total

- **Phases 0–4 (revenue MVP):** 33–43 weeks at 1–2 FT engineers
- **Phases 5–6 (hardening + bots):** +14–18 weeks
- **Cost band (spec §28):** $80–120k engineering + $5–10k legal + $5k design + $3–8k infra during build

**End of plan.**
