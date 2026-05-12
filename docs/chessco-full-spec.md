# Chessco — Full System Specification

**Name:** Chessco
**Domain:** chessco.org (`.com` to acquire if available; see §27)
**Slogan:** Scout. Prepare. Win.
**Version:** 1.1 (Plan Mode — pre-development)
**Document type:** Developer handover specification
**Author:** Boaz Telem
**Status:** Draft for review
**Last updated:** 2026-05-11

> **Branding note for marketplace surfaces:** The slogan "Scout. Prepare. Win." anchors the master brand and is appropriate for the prep features (Feature 1 and Feature 2). On marketplace surfaces (Feature 3 — paid sparring), copy must avoid result-conditional framing per §3. Use the marketplace sub-tagline _"Practice the positions that matter"_ (or equivalent) instead of "Win" wherever fees and payouts are visible on the same surface.

---

## Table of Contents

1. Executive summary
2. Product architecture
3. Core legal framing (foundational — read before anything else)
4. Tech stack
5. Data model
6. Feature 1 — Player discovery & identification
7. Feature 2 — Opponent preparation engine
8. Feature 3 — Paid sparring marketplace
9. Rating system (Glicko-2)
10. Trust score
11. Refund system
12. Anti-cheat
13. Wallet & payments (Stripe Connect)
14. Live game server
15. AI integration
16. Frontend — application pages
17. Frontend — marketing site
18. Blog strategy
19. Knowledge base
20. Legal pages
21. Email & notifications
22. Admin & operations
23. Monitoring & analytics
24. Security & compliance
25. Phased roadmap
26. Risk register
27. Open decisions
28. Developer handover notes
29. Appendices

---

## 1. Executive Summary

Chessco is a chess preparation and sparring platform built around three integrated capabilities:

1. **Player discovery** — identify an opponent's public chess accounts from partial information (name, club, rating range, location, sample game) using engineered features and learned stylistic embeddings.
2. **Opponent preparation** — generate per-opponent battle plans showing their opening repertoire, recurring mistakes, and exploitable lines compared against the user's own play style.
3. **Paid sparring marketplace** — let users publish a starting position and pay a fixed fee per game to have a verified human opponent practice it with them. The opponent is paid for **playing the game to completion**, regardless of the result.

The product is positioned as a _preparation tool for serious chess players_ — competitive online players, tournament players, club players, and coaches — not as casual entertainment. Lichess and chess.com cover casual play; Chessco is the layer on top for people who treat their next game seriously enough to prepare for it.

**Business model.** Subscriptions for the prep features (Feature 1 + Feature 2), plus per-transaction fees on the sparring marketplace (Feature 3). Target take rate on the marketplace: 10–15% on the transaction. Subscription tier(s) and exact marketplace pricing are open decisions (see §27).

**Why this works.** Lichess and chess.com have the games but not the prep tools. ChessBase has prep tools but is desktop-bound, expensive, and aimed at masters. There is no consumer-grade web product for "scout my next opponent and practice against them" — that's the gap.

---

## 2. Product Architecture

### The single product loop

Everything in Chessco connects through one user narrative:

> **Scout** the opponent → **Find** their weakness → **Practice** the exact position → **Pay** a sparring partner → **Improve**.

Every feature should reinforce this loop. The home page tells this story. The dashboard surfaces this loop. Marketing copy uses these five verbs.

### Free vs. paid surface (initial proposal — open for revision)

| Surface                                               | Free                       | Subscription | Per-transaction |
| ----------------------------------------------------- | -------------------------- | ------------ | --------------- |
| Account linking, own-game import, own-repertoire view | ✓                          |              |                 |
| Search a public player (basic profile)                | ✓                          |              |                 |
| Identification engine ("who is this player")          | Limited                    | ✓            |                 |
| Full opponent prep report                             | Preview                    | ✓            |                 |
| Practice against opponent-style bot (Maia fine-tune)  |                            | ✓            |                 |
| Publish a position challenge                          |                            | ✓            | + per-game fee  |
| Accept a position challenge                           | ✓ (verified accounts only) |              | Earn payout     |

Subscription gates the _intelligence_; the marketplace is gated by _verification_. Free users can earn payouts (which incentivizes verification) but cannot publish challenges (which limits abuse).

### Service topology

```
                    ┌──────────────────────────────────────────┐
                    │           Next.js on Vercel              │
                    │  (marketing, app shell, dashboards,      │
                    │   forms, server actions, route           │
                    │   handlers / API routes)                 │
                    └──────┬───────────────────────────────┬───┘
                           │                               │
                           ▼                               ▼
              ┌────────────────────┐         ┌──────────────────────┐
              │   Supabase         │         │   Fly.io game server │
              │   (Postgres, Auth, │◄────────┤   (Node + WebSocket, │
              │   Storage,         │ writes  │   authoritative state│
              │   Realtime,        │ moves   │   clocks, escrow     │
              │   pgvector)        │         │   triggers)          │
              └──────┬─────────────┘         └──────────┬───────────┘
                     │                                   │
                     ▼                                   ▼
              ┌────────────────────┐         ┌──────────────────────┐
              │   Inngest workers  │         │   Upstash Redis      │
              │   (PGN ingest,     │         │   (matchmaking queue,│
              │   Stockfish batch, │         │   game state cache,  │
              │   embedding build, │         │   rate limits,       │
              │   AI reports)      │         │   presence)          │
              └──────┬──────┬──────┘         └──────────────────────┘
                     │      │
                     ▼      ▼
       ┌──────────────┐ ┌──────────────┐
       │ Stockfish    │ │ Anthropic    │
       │ workers      │ │ Claude API   │
       │ (Cloud Run)  │ │              │
       └──────────────┘ └──────────────┘

       ┌──────────────────────────────────────────────────┐
       │   Stripe Connect (Express accounts, payouts,     │
       │   KYC, deposits, webhooks → Next.js → Postgres)  │
       └──────────────────────────────────────────────────┘
```

---

## 3. Core Legal Framing (FOUNDATIONAL)

**Read this section before writing any code, copy, or contract.**

Chessco is a **paid sparring services marketplace**. It is not a gambling, betting, prize-competition, or skill-gaming platform.

### The completion-based payout rule

When a user publishes a position challenge with a $X fee, and an opponent accepts:

- The opponent is paid for **playing the game to its natural conclusion** (checkmate, resignation, stalemate, draw by repetition, draw by 50-move rule, draw by insufficient material, or any normal game-ending event).
- The payout amount is **fixed** at acceptance time.
- The payout amount **does not depend on the result**. Win, lose, or draw — same payout.
- A game is only "completed" if the opponent played the position as published, made legal moves, and did not abandon (disconnect beyond grace period without return).

This single design choice is what keeps the platform outside of gambling regulation across most jurisdictions. Every other decision flows from it.

### Forbidden vocabulary

The following words and concepts must never appear in product, marketing, or UX copy:

- "Bet" / "betting" / "wager" / "stakes"
- "Win money" / "prize" / "jackpot" / "earnings from winning"
- "Odds" / "payout odds"
- Anything framing the opponent's payment as conditional on game result

Allowed vocabulary: "fee," "sparring fee," "session fee," "practice session," "publish a challenge," "accept a challenge," "payout for completed session," "earn for completing sessions."

### Stripe MCC and platform classification

The platform must be classified at Stripe under a **services marketplace** MCC (e.g. 8299 — Educational Services, or 7392 — Management/Consulting/Public Relations Services). Do not classify as gaming, gambling, or any 79xx code. Coordinate with Stripe contact (Mitch) on initial application.

### Jurisdictional strategy (initial proposal)

- **Phase 1 launch:** Israel, EU, UK, Canada, Australia. Permissive paid-services environments where completion-based services are unambiguously legal.
- **Phase 2:** Most US states. Geo-block Washington, Tennessee, and any state with active "skill-gaming as gambling" enforcement (legal review required before each state opens).
- **Permanent geoblock:** India (recent paid online gaming restrictions), Saudi Arabia, UAE for paid features (browse-only). Confirm with counsel.

This is enforced at IP-geolocation level at the marketplace surface only. Free prep features can be available globally.

### Required legal review before marketplace launch

A written legal opinion is required confirming:

1. Completion-based payout structure does not constitute gambling in target jurisdictions.
2. No license is required to operate the sparring marketplace.
3. KYC / AML obligations are met via Stripe Connect Express.
4. Tax reporting obligations (1099-K equivalents) are handled by Stripe or by us.
5. The product copy is reviewed for compliance with the framing above.

---

## 4. Tech Stack

### Frontend

- **Framework:** Next.js 15 (App Router), TypeScript strict mode
- **Styling:** Tailwind CSS, shadcn/ui (Radix primitives), CSS variables for theming
- **State:** TanStack Query (server state), Zustand (client/game state), React Hook Form + Zod (forms)
- **Charts:** Recharts (default), Tremor (dashboards)
- **Chess board:** `react-chessboard` for MVP; migrate to **Chessground** (Lichess's open-source board) once game volume justifies the polish
- **Chess logic:** `chess.js` for move validation and PGN parsing client-side
- **Animation:** Framer Motion
- **Tables:** TanStack Table
- **Engine in browser:** Stockfish WASM

### Backend

- **Database:** Supabase Postgres (with `pgvector` extension enabled from day one)
- **Auth:** Supabase Auth (email/password, magic link, Google OAuth, Apple)
- **Storage:** Supabase Storage (PGN files, avatars, prep reports as PDF)
- **Realtime:** Supabase Realtime for lobby presence, notifications, non-game-critical updates
- **Hosting (web):** Vercel
- **Game server:** Fly.io (Node 20+ or Bun, WebSocket via `ws`, single region close to majority of users — Frankfurt or Amsterdam for EU/IL launch)
- **Queues / state cache:** Upstash Redis
- **Background jobs:** Inngest (event-driven workflow engine, integrates with Next.js)
- **Engine workers:** Stockfish 16+ in containers on Google Cloud Run, autoscaling
- **AI:** Anthropic Claude API (Claude Opus for narrative reports; Claude Haiku for short-form completions and prompts that don't need depth)
- **Payments:** Stripe Connect Express accounts
- **Email:** Resend (transactional) + Loops or Customer.io (lifecycle)
- **Monitoring:** Sentry (errors), Vercel Analytics + PostHog (product analytics), BetterStack (uptime + logs)
- **Search:** Postgres trigram + pgvector for player search; consider Typesense later if needed

### DevOps / repository

- Single monorepo with Turborepo or pnpm workspaces
- Apps: `web` (Next.js), `gameserver` (Node WebSocket), `workers` (Inngest functions)
- Shared packages: `db` (Drizzle ORM schema + migrations), `types`, `ui`, `chess-core` (PGN/FEN/engine helpers), `analytics`
- ORM: **Drizzle** (recommended over Prisma for raw SQL access needed by analytics queries)
- CI: GitHub Actions
- Environments: `local`, `preview` (Vercel preview deploys), `staging` (full mirror), `production`

---

## 5. Data Model

All tables in Postgres. Naming convention: snake_case, plural table names, primary key `id uuid` (using `gen_random_uuid()`), timestamps `created_at` / `updated_at` with triggers.

### Identity & accounts

```sql
profiles
  id uuid PK
  username text UNIQUE          -- platform handle
  display_name text
  email text UNIQUE
  avatar_url text
  country text                  -- ISO 3166-1 alpha-2
  city text
  date_of_birth date            -- required for paid play (18+)
  chess_title text              -- GM, IM, FM, NM, CM, WGM, etc.
  bio text
  preferred_language text
  marketing_consent boolean
  is_verified boolean           -- KYC complete
  kyc_status text               -- 'none' | 'pending' | 'approved' | 'rejected'
  stripe_account_id text        -- Connect Express account
  stripe_customer_id text       -- for deposits
  created_at, updated_at, last_seen_at, deleted_at

external_accounts
  id uuid PK
  profile_id uuid FK → profiles
  platform text                 -- 'lichess' | 'chess.com' | 'fide' | 'chess-results'
  external_id text              -- their handle / FIDE ID
  external_url text
  verified boolean              -- did we confirm ownership via OAuth or bio token
  confidence_score numeric      -- if unverified, our matching confidence
  rating_blitz int
  rating_rapid int
  rating_classical int
  rating_bullet int
  last_synced_at timestamptz
  created_at

verification_tokens
  id uuid PK
  profile_id uuid FK
  platform text
  token text                    -- one-time string user pastes in their lichess/chess.com bio
  consumed boolean
  expires_at timestamptz
```

### Federations & official rating lists

These tables hold the **canonical real-world identity anchors** — official OTB rating lists from FIDE and national federations. Per the architectural shift documented in §6, identification is name-anchored against these tables first, then matched to online accounts.

```sql
federations
  id text PK                       -- 'FIDE' | 'USCF' | 'ECF' | 'DSB' | 'FSI' | ...
  name text                        -- 'International Chess Federation'
  country text                     -- nullable for FIDE (international)
  rating_list_url text             -- source URL for ingestion
  rating_list_format text          -- 'xml' | 'csv' | 'json' | 'html'
  sync_cadence text                -- 'monthly' | 'quarterly' | 'manual'
  last_synced_at timestamptz
  active boolean

federation_players               -- one row per (federation × person)
  id uuid PK
  federation_id text FK → federations
  federation_player_id text      -- the player's id in that federation (FIDE ID, USCF ID, etc.)
  name text                      -- "Telem, Boaz" (federation's canonical form)
  name_normalized text           -- "boaz telem" (lowercased, accent-stripped, for fuzzy match)
  country text                   -- ISO 3166-1 alpha-2; player's federation country
  birth_year int                 -- if public
  gender char(1)
  title text                     -- 'GM' | 'IM' | 'FM' | 'CM' | 'WGM' | etc., nullable
  rating_standard int            -- nullable
  rating_rapid int
  rating_blitz int
  rating_quick int               -- USCF-specific
  player_id uuid FK → players    -- nullable; set when resolved to canonical player
  last_updated_at timestamptz
  raw jsonb                      -- original record for diffing
  UNIQUE (federation_id, federation_player_id)
  INDEX (name_normalized)        -- trigram index
  INDEX (country, rating_standard)
  INDEX (player_id)

federation_rating_snapshots    -- monthly history of ratings (for trend analysis)
  id bigserial PK
  federation_player_id uuid FK → federation_players
  snapshot_date date
  rating_standard int
  rating_rapid int
  rating_blitz int
  title text
  UNIQUE (federation_player_id, snapshot_date)
  INDEX (federation_player_id, snapshot_date DESC)
```

**Trigram index for name search:**

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX federation_players_name_trgm_idx
  ON federation_players USING gin (name_normalized gin_trgm_ops);
```

This enables fast fuzzy lookup like `WHERE name_normalized % 'boaz telem'` returning hits even with typos or formatting variation.

### Players, games, positions

Note: **players** is the canonical "person" concept. A profile is a registered user. A player may exist without a profile (e.g. a famous GM whose games we have ingested but who hasn't signed up).

```sql
players
  id uuid PK
  canonical_name text           -- "Magnus Carlsen"
  profile_id uuid FK → profiles -- nullable; set if linked to a registered user
  country text
  fide_id text
  peak_rating int
  embedding vector(384)         -- pgvector, learned style embedding
  created_at, updated_at

player_aliases
  id uuid PK
  player_id uuid FK → players
  platform text
  handle text
  confidence numeric            -- 0..1
  source text                   -- 'verified' | 'manual' | 'inferred'
  created_at

games
  id uuid PK
  source text                   -- 'lichess' | 'chess.com' | 'upload' | 'fide' | 'pgn_import'
  source_game_id text           -- e.g. lichess game id
  white_player_id uuid FK → players
  black_player_id uuid FK → players
  white_handle_snapshot text    -- handle at game time
  black_handle_snapshot text
  white_rating int
  black_rating int
  pgn text                      -- canonical PGN
  initial_fen text              -- for non-standard start (Chess960, FENs, etc.)
  result text                   -- '1-0' | '0-1' | '1/2-1/2' | '*'
  termination text              -- 'normal' | 'time' | 'resignation' | 'abandoned' | etc.
  time_control text             -- '180+2' style
  time_class text               -- 'bullet' | 'blitz' | 'rapid' | 'classical' | 'correspondence'
  opening_eco text              -- 'B90'
  opening_name text             -- 'Sicilian Defense: Najdorf'
  ply_count int
  played_at timestamptz
  imported_at timestamptz
  raw_meta jsonb                -- original headers
  UNIQUE (source, source_game_id)

positions                       -- intern FENs to save space across stats
  id bigserial PK
  fen text UNIQUE               -- full FEN
  fen_hash bigint UNIQUE        -- 64-bit hash for fast lookup
  side_to_move char(1)          -- 'w' | 'b'
  ply int                       -- typical ply this position appears at (denormalized hint)
  eco text                      -- if a named opening node
  opening_name text
  created_at

moves
  id bigserial PK
  game_id uuid FK → games
  ply int                       -- 1-indexed half-move
  san text                      -- 'Nf3'
  uci text                      -- 'g1f3'
  fen_before_id bigint FK → positions
  fen_after_id bigint FK → positions
  clock_white_ms int            -- nullable, depends on source
  clock_black_ms int
  eval_before_cp int            -- centipawn eval before move
  eval_after_cp int             -- after move
  eval_before_mate int          -- nullable mate-in-N
  eval_after_mate int
  cp_loss int                   -- centipawn loss attributable to this move
  is_book_move boolean
  is_blunder boolean            -- cp_loss > 200 by convention
  is_mistake boolean            -- cp_loss > 100
  is_inaccuracy boolean         -- cp_loss > 50

  INDEX (game_id, ply)
  INDEX (fen_before_id)
```

**Partitioning note.** The `games` and `moves` tables will dominate storage. Plan to partition `games` by `played_at` month (monthly partitions) from day one — see §6 "Storage realism." Drizzle supports declarative partitioning via raw SQL migrations.

### Per-player aggregates (the analytical backbone)

```sql
player_position_stats           -- "what does this player do from this position"
  id bigserial PK
  player_id uuid FK → players
  position_id bigint FK → positions
  color char(1)                 -- 'w' | 'b' — the color this player had
  games_count int
  wins int
  draws int
  losses int
  avg_cp_loss_next_move numeric
  blunder_rate numeric
  last_seen_at timestamptz
  UNIQUE (player_id, position_id, color)
  INDEX (player_id, color, games_count DESC)

player_opening_stats            -- "what do they play after this position"
  id bigserial PK
  player_id uuid FK → players
  position_id bigint FK → positions
  color char(1)
  next_move_uci text
  next_move_san text
  games_count int
  wins int
  draws int
  losses int
  avg_cp_loss numeric
  UNIQUE (player_id, position_id, color, next_move_uci)

style_features                  -- engineered feature vector per player
  player_id uuid PK FK → players
  features jsonb                -- 200-500 named features
  computed_at timestamptz
  games_window int              -- how many recent games this is based on
```

### Identification queries & candidates

Persist identification results so users can revisit, refine, and audit:

```sql
identification_queries
  id uuid PK
  requested_by uuid FK → profiles
  query_payload jsonb            -- name, country, FIDE ID, rating range, PGN sample, etc.
  status text                    -- 'pending' | 'ready' | 'failed'
  created_at, completed_at

identification_candidates
  id bigserial PK
  query_id uuid FK → identification_queries
  rank int                       -- 1..5
  federation_player_id uuid FK → federation_players  -- nullable if anonymous-only result
  player_id uuid FK → players    -- nullable
  confidence_label text          -- 'high' | 'medium' | 'low'
  combined_score numeric
  anchor_score numeric           -- Stage 1
  handle_score numeric           -- Stage 2
  style_score numeric            -- Stage 3
  evidence jsonb                 -- structured findings + LLM-generated evidence prose
  created_at
  INDEX (query_id, rank)
```

### Reports

```sql
prep_reports
  id uuid PK
  requested_by uuid FK → profiles
  user_player_id uuid FK → players       -- the requesting user's player record
  target_player_id uuid FK → players     -- the opponent
  status text                            -- 'pending' | 'building' | 'ready' | 'failed'
  summary text                           -- LLM-generated executive summary
  recommended_white_lines jsonb
  recommended_black_lines jsonb
  avoid_lines jsonb
  practice_positions jsonb               -- array of {fen, rationale, urgency}
  raw_findings jsonb                     -- structured engine + stat findings
  pdf_url text                           -- generated downloadable report
  created_at, completed_at, expires_at   -- regen on schedule
  INDEX (requested_by, created_at DESC)
```

### Marketplace

```sql
challenges
  id uuid PK
  creator_id uuid FK → profiles
  fen text                       -- starting position
  pgn_prefix text                -- optional: the moves leading to the FEN
  creator_color char(1)          -- 'w' | 'b' — what color the creator wants to play
  time_control text              -- '180+2'
  time_class text                -- 'bullet' | 'blitz' | 'rapid' | 'classical'
  fee_cents int                  -- in user's currency
  currency char(3)
  rating_min int
  rating_max int
  required_trust_score int       -- minimum trust to accept
  games_requested int            -- usually 1; can be multi-game match
  games_completed int
  status text                    -- 'open' | 'matched' | 'completed' | 'cancelled' | 'expired'
  expires_at timestamptz
  notes text                     -- creator's prep context, shown to opponent post-match
  created_at, updated_at
  INDEX (status, time_class, rating_min, rating_max)

matches
  id uuid PK
  challenge_id uuid FK → challenges
  opponent_id uuid FK → profiles
  fee_cents int                  -- copied at match time (immutable)
  platform_fee_cents int         -- computed at match time (immutable)
  opponent_payout_cents int      -- fee - platform_fee
  status text                    -- see match state machine below
  accepted_at, started_at, completed_at, settled_at timestamptz
  game_id uuid FK → live_games
  review_window_expires_at timestamptz
  INDEX (opponent_id, status)
  INDEX (challenge_id)

live_games                       -- authoritative game record (mirrors from game server)
  id uuid PK
  match_id uuid FK → matches
  white_user_id uuid FK → profiles
  black_user_id uuid FK → profiles
  initial_fen text
  pgn text                       -- updated as game progresses
  current_fen text
  time_control text
  white_time_ms int
  black_time_ms int
  result text                    -- null until ended
  termination text
  status text                    -- 'live' | 'completed' | 'aborted' | 'abandoned'
  started_at, completed_at timestamptz

match_moves                      -- denormalized authoritative move log
  id bigserial PK
  match_id uuid FK → matches
  ply int
  san text
  uci text
  time_remaining_ms int          -- clock after this move
  client_timestamp timestamptz
  server_timestamp timestamptz
  INDEX (match_id, ply)
```

### Wallet & ledger

```sql
wallets
  id uuid PK
  profile_id uuid FK UNIQUE → profiles
  available_cents int            -- withdrawable / spendable
  pending_cents int              -- held in escrow
  currency char(3)
  created_at, updated_at

ledger_entries                   -- double-entry: every $ movement = 2 rows
  id uuid PK
  transaction_id uuid            -- groups related entries
  account_type text              -- 'user_wallet' | 'platform_revenue' | 'escrow' | 'stripe_clearing' | 'refund_reserve'
  account_id uuid                -- profile_id when user_wallet, null for system accounts
  direction char(1)              -- 'D' (debit) | 'C' (credit)
  amount_cents int               -- always positive; direction encodes sign
  currency char(3)
  category text                  -- 'deposit' | 'match_escrow' | 'match_payout' | 'platform_fee' | 'withdrawal' | 'refund' | 'reversal'
  reference_type text            -- 'match' | 'stripe_payment' | 'payout' | 'manual'
  reference_id text
  reversible_until timestamptz   -- nullable; for entries that may be reversed by refund
  reversed_by uuid               -- FK to ledger_entries.id if reversed
  metadata jsonb
  created_at
  INDEX (transaction_id)
  INDEX (account_type, account_id, created_at)

stripe_events                    -- raw Stripe webhook log for replay/audit
  id text PK                     -- Stripe event id
  type text
  payload jsonb
  processed boolean
  processed_at timestamptz
  received_at timestamptz
```

### Rating & trust

```sql
ratings
  profile_id uuid PK FK → profiles
  skill_rating numeric           -- Glicko-2 rating
  skill_rd numeric               -- rating deviation
  skill_volatility numeric
  trust_score int                -- 0..100
  trust_tier text                -- 'new' | 'bronze' | 'silver' | 'gold' | 'platinum'
  paid_games_completed int
  paid_games_abandoned int
  refunds_filed int
  refunds_granted int
  refunds_denied int
  fairplay_flags int
  last_recalculated_at timestamptz

rating_history
  id bigserial PK
  profile_id uuid FK
  match_id uuid FK
  skill_rating_before numeric
  skill_rating_after numeric
  trust_score_before int
  trust_score_after int
  reason text
  created_at
```

### Refunds

```sql
refund_requests
  id uuid PK
  match_id uuid FK → matches
  requester_id uuid FK → profiles
  respondent_id uuid FK → profiles
  reason_code text               -- enumerated, see §11
  reason_detail text             -- short user note; not used for routing
  evidence jsonb                 -- optional uploads (chat log refs, screenshots)
  status text                    -- 'open' | 'auto_approved' | 'under_review' | 'approved' | 'denied' | 'reversed'
  amount_cents int
  resolution_notes text
  resolved_by uuid               -- admin profile id, null if auto-resolved
  auto_resolution_rule text      -- name of rule that fired
  created_at, resolved_at
  INDEX (status, created_at)
```

### Anti-cheat

```sql
fairplay_flags
  id uuid PK
  profile_id uuid FK → profiles
  match_id uuid FK → matches      -- nullable
  game_id uuid FK → games         -- nullable, for non-paid games
  flag_type text                  -- 'engine_correlation' | 'tab_switching' | 'time_pattern' | 'manual_report' | 'sandbagging'
  severity int                    -- 1..10
  signals jsonb                   -- raw data
  reviewed_by uuid                -- null until reviewed
  outcome text                    -- 'confirmed' | 'dismissed' | 'pending'
  action_taken text               -- 'none' | 'warning' | 'paid_play_suspended' | 'banned'
  created_at, reviewed_at

fairplay_telemetry              -- raw signals collected during paid games
  id bigserial PK
  match_id uuid FK → matches
  profile_id uuid FK → profiles
  event_type text                 -- 'tab_blur' | 'tab_focus' | 'mouse_idle' | 'paste_detected' | 'devtools_open'
  event_data jsonb
  client_timestamp timestamptz
  server_timestamp timestamptz
  INDEX (match_id, profile_id)
```

### Audit & admin

```sql
audit_logs
  id bigserial PK
  actor_type text                 -- 'user' | 'admin' | 'system'
  actor_id uuid
  action text                     -- 'wallet.adjust', 'match.force_settle', 'profile.ban', etc.
  target_type text
  target_id text
  before jsonb
  after jsonb
  reason text
  created_at
  INDEX (actor_id, created_at DESC)
  INDEX (target_type, target_id)

admin_users
  profile_id uuid PK FK → profiles
  role text                       -- 'support' | 'moderator' | 'admin' | 'finance'
  permissions jsonb
  created_at
```

### Critical indexes (beyond those inline above)

- `games(played_at DESC)` for time-window queries
- `moves(fen_before_id, is_blunder)` for "blunders from this position"
- `player_position_stats(player_id, games_count DESC)` for "most common positions"
- `challenges` partial index `WHERE status = 'open'` for the lobby feed
- pgvector HNSW index on `players.embedding`
- pg_trgm GIN index on `federation_players.name_normalized` (declared above)

---

## 6. Feature 1 — Player Discovery & Identification

### Goal

Take partial information about an opponent and return a ranked list of candidate public chess accounts, with evidence.

### Inputs accepted

- Free-text query ("an 1850 from Israel who plays the King's Indian")
- Username on any platform
- Real name + country
- Club / team / federation
- Tournament name
- FIDE ID
- Single uploaded PGN (sample game)
- Multiple uploaded PGNs
- Known opening (ECO code or name)

### Outputs

- Ranked list of up to 5 candidate `players` records
- For each: confidence label (`high` / `medium` / `low`), evidence panel ("matches on opening repertoire 87%, country match, similar time-control distribution"), linked external accounts, recent activity
- A single "this is the player I'm preparing against" CTA on each candidate, which becomes the seed for Feature 2

### Ingestion pipeline

**Priority order — build in this sequence:**

| #   | Source                               | Method                | Frequency      | Notes                                                                                      |
| --- | ------------------------------------ | --------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| 1   | **FIDE ratings list**                | XML download          | Monthly        | ~400k rated players globally; the canonical identity anchor for all OTB-titled play        |
| 2   | **USCF top lists & member lookup**   | HTML + manual         | Monthly        | US-specific anchor; ratings list is public, full member directory is paywalled             |
| 3   | **Lichess monthly DB dumps**         | zstd-compressed PGN   | Monthly        | Filter to rated games ≥ 1500 in last 24 months; parse with `pgn-extract` or `python-chess` |
| 4   | **Chess.com PubAPI player archives** | API call on demand    | Per-query      | Read-only; cache 7 days per player                                                         |
| 5   | **Lichess user API**                 | API call on demand    | Per-query      | OAuth for the user's own account; public endpoints for others; respect rate limits         |
| 6   | **Additional national federations**  | Per-federation parser | Monthly        | ECF (UK), DSB (DE), FSI (IT), FFE (FR), etc. — add as launch markets expand                |
| 7   | **Chess-Results**                    | Manual / sparingly    | Per-tournament | OTB tournament cross-tables; respect robots.txt                                            |
| 8   | **User uploads**                     | Direct upload         | On demand      | PGN parser, up to 1000 games per upload                                                    |

**Why this order matters.** Steps 1–3 build the canonical identity-and-games corpus. Step 4 is lazy: chess.com cannot be bulk-ingested (their PubAPI is read-only, no bulk endpoint), so we fetch per-player on demand and cache. Steps 5+ are incremental.

**Rate limit handling:** Lichess explicitly prefers serial requests with backoff on 429. Implement a token-bucket rate limiter in the Inngest workers with conservative defaults (60 requests/min for Lichess, 30/min for chess.com). Cache aggressively.

**Storage tiering:** Don't store every game from every player globally. Tier:

- **Tier A (hot, fully analyzed):** Players who are subjects of active prep reports, plus their recent 200 games each, with engine analysis on every move.
- **Tier B (warm, partial analysis):** Players in our database from prior queries, last 100 games each, opening + cp loss only.
- **Tier C (cold, indexed only):** Lichess monthly dump games at scale, used for stylometry training and lookup; no per-game engine analysis.

**Storage realism:** Filtered Lichess (rated ≥ 1500, last 24 months) is roughly 150–200M games, ~400–600GB normalized in Postgres with FEN interning. Plan to partition `games` by `played_at` month from day one. If this exceeds Supabase's tier limits, split the games corpus to a dedicated Postgres (RDS or Cloud SQL) and keep Supabase for app data.

### Identification engine (name-anchored, three-stage)

The architecture is **name-anchored against official rating lists**, not style-anchored. Style is a verifier, not a searcher. (Architectural note: this approach was validated by SnoopChess's product, which proves the name-anchored approach works at scale — see Appendix C.)

**Stage 1 — Resolve identity anchor.**

Parse the query to extract: name, country, federation, FIDE/USCF ID, rating range, title. Query `federation_players` using trigram fuzzy match on `name_normalized`, filtered by country/federation/rating where provided. Return top 5–20 candidate federation records, each with confidence based on:

- Exact ID match (federation_player_id provided) → 1.0
- Trigram similarity score on normalized name
- Country / federation match (boosts)
- Rating-range match (boosts)

If the user provided no real-world identity (e.g. only a username, only a PGN, only an opening), skip Stage 1 and go straight to Stage 3 using anonymous candidates from external accounts.

**Stage 2 — Find candidate online accounts per anchor.**

For each Stage 1 candidate, generate hypotheses for online accounts:

- Query `external_accounts` for handles where `handle ~ name_parts` (e.g. "Telem" → "telembx", "btelem", "boazt", etc.) using trigram on handle
- Query `external_accounts` by country match
- Query by rating-band match (their online blitz/rapid should be within ±300 of their FIDE standard)
- Optional: live-fetch chess.com / Lichess for handles matching the name pattern, if not in our cache

Output per anchor: up to 10 candidate handles across platforms.

**Stage 3 — Stylometric verification & ranking.**

For each candidate (anchor × handle) pair:

1. Pull the candidate's recent games (from cache or live fetch)
2. Compute engineered features (opening repertoire, average cp loss, time management curve, tactical patterns)
3. If the user supplied a sample PGN, compute features for it; otherwise use only the candidate's own features
4. Compute embedding via the trained encoder; compare against:
   - The user's sample PGN embedding (if provided), OR
   - Other candidate handles for the same anchor (sibling-account consistency check)
5. Score each (anchor, handle) by:
   - Stage 1 anchor confidence × Stage 2 handle plausibility × Stage 3 stylistic consistency
   - Activity recency (heavy weight on last 90 days)
   - Cross-platform consistency (handles on Lichess and chess.com that match each other earn a boost)
6. Return top 5 with confidence labels (`high` / `medium` / `low`) and evidence text generated by Claude from the structured findings

**Confidence thresholds (initial):**

- `high`: combined score > 0.80, top result > 2× second result
- `medium`: combined score > 0.60
- `low`: combined score > 0.40
- Below 0.40 → return no results rather than guess

**Engineered features and learned embedding (technical detail).**

Engineered features per player corpus (200–500 named features):

- Opening repertoire histogram (top 30 ECO codes by frequency, separated by color)
- Average centipawn loss by phase (opening 1–15, middlegame 16–40, endgame 41+)
- Time management curve (% of total time spent by phase)
- Tactical motif frequencies (forks, pins, skewers, discovered attacks — derived from engine analysis)
- Blunder context features (blunders in time pressure vs. not, blunders in quiet vs. tactical positions)
- Endgame conversion rates (won endgames converted, drawn endgames held)
- Move time distribution percentiles
- Premove frequency (chess.com / Lichess specific)
- Resign behavior (resigns when losing by how much, on average)
- Draw offer frequency

Stored as `style_features.features` jsonb plus the float vector for fast comparison.

Learned embedding: a small transformer encoder ingests a sequence of game-level feature vectors and outputs a 384-dim embedding. Training objective: contrastive loss — embeddings of two random game batches from the same player should be close (cosine), batches from different players should be far. Store as `players.embedding` via pgvector.

### Privacy & ethics (mandatory defaults)

- **Default identification scope:** Public OTB-rated players (FIDE, USCF, national federation members) are inherently public — their name, country, and rating are voluntarily published by the federation. Linking them to their own publicly-played Lichess/chess.com accounts is permitted by default.
- **Anonymous online accounts are off-limits** by default. A user can opt in to "make my anonymous accounts discoverable" if they want — it's a privacy _choice_, not the default.
- **Doxxing prevention:** Search results never display physical addresses, real-time location, contact info, or any data not voluntarily public on the source platform or rating list.
- **Right to delist:** Any player can request removal of their player record at no cost. Verified ownership via email-on-file or platform OAuth. Federation rating data can be hidden from search even if technically public, on request.
- **No identification of suspected cheaters by third parties.** "Help me find out who this engine user is" is an explicit no.
- **No reverse-lookup tools.** We do not offer "given this Lichess handle, find their real identity" — only the forward direction (given real identity, find their online play). The reverse direction would invite stalking; we don't build it.

### UX (player search & profile)

**Search page (`/scout`):**

- Single command-bar input at top, accepting any of the inputs above
- Filter chips below: country, rating range, federation, title, time class
- Results render as cards with: name, country flag, peak rating, federation badge (FIDE/USCF/etc.), tags ("Najdorf player", "fast bullet", "endgame strong"), linked external accounts, "Build prep report" CTA
- Empty state: explainer + sample queries
- Federation browse mode: `/scout/federation/{id}` shows ranked lists by federation (mirroring what SnoopChess exposes; useful for SEO and discovery)

**Player profile page (`/p/[player_id]`):**

- Header: name, photo (if public), country, title, peak ratings across platforms, federation IDs
- Tabs: Overview, Openings, Mistakes, Recent games, Style fingerprint, Ratings history
- Overview: 6-card grid — preferred openings, strongest time class, win-rate trend, opening surprise factor, endgame strength, time management style
- Openings: sunburst of repertoire by color
- Mistakes: heatmap of common blunder positions, with most frequent ones clickable
- Recent games: paginated list with engine-eval mini-graphs
- Style fingerprint: prose summary (LLM) + radar chart on 8 axes
- Ratings history: chart of standard/rapid/blitz across federations and online platforms over time
- Sticky CTA: "Prepare to play against this player"

---

## 7. Feature 2 — Opponent Preparation Engine

### Goal

Given the user's own player record and a target opponent's player record, produce a usable battle plan.

### Output shape

```
PrepReport {
  summary: "Three-paragraph executive overview"
  recommended_white_lines: [
    { eco, opening_name, sequence, rationale, expected_score, sample_games }
  ]
  recommended_black_lines: [...]
  avoid_lines: [...]
  practice_positions: [
    { fen, rationale, urgency: 'critical' | 'recommended' | 'optional', source_games }
  ]
  raw_findings: { ... structured data behind the report ... }
}
```

### Pipeline

**Step 1 — Build per-player opening trees.**

For each player, traverse all known games and aggregate per (`position_id`, color) tuple. Prune nodes with `games_count < 3` to control tree size. Record:

- Next-move distribution (frequency, win rate, average cp loss)
- Eventual game outcomes from that position (score from this player's perspective)
- Time-pressure incidence (how often did they reach time trouble after this position)

**Step 2 — Detect leaks.**

A "leak" is a position where:

1. Reachable from the user's repertoire (the user can plausibly steer the game here),
2. The opponent has visited ≥ 5 times,
3. The opponent's score is poor (e.g. < 45% from a position with eval ≈ 0),
4. The opponent's most common next move has noticeable cp loss (≥ 30 average), OR is theoretically inferior (engine eval ≥ +0.5 in opponent's disfavor),
5. The user has played the surrounding line ≥ 3 times with a positive score, OR the engine evaluation is comfortable for the user's expected play.

Each leak gets a severity score combining: position frequency × score gap × cp loss × user's familiarity.

**Step 3 — Generate recommended lines.**

Walk forward from each detected leak and produce 2–4 concrete recommended move sequences. Annotate each move with: engine eval, frequency in master games, and opponent's likely response.

**Step 4 — Select practice positions.**

From the top leaks, pick 5–10 positions the user should drill. Annotate with:

- Why this position matters
- Recommended plan from the position
- Optional: a Maia-trained bot variant for sparring against this exact opponent's style

**Step 5 — AI narrative layer.**

Pass the structured findings to Claude with a strict prompt. The LLM's job is _summarization and tone_, not chess analysis. The engine's numbers are ground truth; the LLM explains them in coach-speak.

Sample prompt skeleton:

```
You are a chess preparation coach summarizing structured findings.
Do NOT analyze positions yourself. Do NOT make up moves or evaluations.
Only describe the findings I give you in clear, practical language.

User: {handle, rating, title, opening repertoire summary}
Opponent: {handle, rating, title, summary}

Structured findings:
{json with detected leaks, recommended lines, position frequencies, scores}

Output:
- A 3-paragraph executive summary (game plan against this opponent)
- 3 short tips, each tagged "as White" or "as Black"
- 1 paragraph on risks (lines to avoid)
- Tone: professional, direct, no chess clichés, no "battle" language
```

### Caching & freshness

- Reports cache for 30 days. After that, regenerate using fresh game data (worth showing "report based on N games up to {date}").
- If the opponent plays a tournament between requests, allow on-demand refresh (subscription-tier limited).

### Output formats

- **In-app:** interactive page with collapsible sections, embedded board widgets showing recommended lines.
- **PDF:** branded, printable battle plan — use Playwright + Chromium for HTML-to-PDF rendering (established preferred approach). Save to Supabase Storage, signed URL.
- **PGN export:** all recommended lines as a single PGN file with variations and comments, importable to ChessBase / Lichess study / chess.com analysis.

### Maia-based opponent sparring (Phase 4+)

Maia is the CMU/Toronto open-source neural-net engine designed to play like specific rating levels. We can fine-tune it on a specific player's games to produce a bot that plays "in their style." Use cases:

- Drill mode: practice each recommended line against a bot that mimics the opponent.
- Sandbox: play a full game against the opponent's bot variant.

Fine-tuning is offline, can take hours, runs in a dedicated job queue. Bot models stored as small files in Supabase Storage.

---

## 8. Feature 3 — Paid Sparring Marketplace

### Goal

Let a user publish a chess starting position and pay a fixed sparring fee to have a verified human opponent play it with them. Opponent is paid for completing the session.

### Challenge creation (`/challenges/new`)

**Inputs:**

- Starting position: FEN editor (drag pieces, paste FEN, or import from a game) — board with engine eval shown live
- Optional context: 1–3 lead-in moves shown to opponent post-game
- Side: which color the creator plays (or "either")
- Time control: dropdown (bullet 1+0, 2+1; blitz 3+0, 3+2, 5+0, 5+3; rapid 10+0, 10+5, 15+10; classical 25+10, 30+0)
- Rating band: min/max for opponent
- Fee: dollar amount per game (with platform fee shown clearly: "You pay $1.00. Opponent receives $0.85.")
- Number of games: 1, 3, 5, 10
- Trust requirement: silver+, gold+, etc.
- Notes for opponent (visible only post-game)

**Validations:**

- Position must be legal (not impossible, not already checkmate/stalemate)
- Engine eval must not be > +5 or < −5 in either side's favor (avoid lost-position challenges that nobody will accept)
- Creator must have sufficient wallet balance for all games (challenge × games)
- Creator must have completed at least one verified external account link
- Creator must be in a permitted jurisdiction

### Lobby (`/challenges`)

- Filter chips: time class, fee range, rating band, side, trust requirement
- Real-time updating list (Supabase Realtime subscription on `challenges WHERE status = 'open'`)
- Each card shows: creator handle (or anonymous), position preview, time control, fee, rating band, expiry
- One-click "Accept" with confirmation modal showing payout and game rules

### Match flow

```
challenge.status: 'open' → 'matched'

Opponent clicks Accept
  ├─ Server checks: trust score ≥ required, rating in band, jurisdiction OK, not the creator
  ├─ Wallet check: creator has sufficient balance
  ├─ Atomic transaction:
  │    ├─ Debit creator wallet → escrow account (ledger entry pair)
  │    ├─ Create match row, status: 'accepted'
  │    └─ Update challenge.status = 'matched' (or stays 'open' if multi-game)
  └─ Notify both players: "Match starting in 30 seconds"

match.status: 'accepted' → 'starting' → 'live'

Both players join the game room (WebSocket connection to game server)
  ├─ If either fails to connect within 60s: match aborted, full refund
  └─ Game server takes over: clocks, move validation, broadcast

match.status: 'live' → 'completed'

Game ends naturally (checkmate, stalemate, resignation, draw, timeout)
  ├─ Game server posts final state to web app
  ├─ match.status = 'completed', completed_at set
  └─ Enter review window (24h)

match.status: 'completed' → 'settled'

After review window expires with no refund request:
  ├─ Atomic transaction:
  │    ├─ Move opponent payout: escrow → opponent wallet (available)
  │    ├─ Move platform fee: escrow → platform_revenue
  │    └─ Set match.settled_at
  └─ Rating + trust updates run

If refund request filed during window:
  └─ match.status = 'disputed' until refund_request resolved
```

### Abandonment handling

If the opponent disconnects mid-game:

- 60-second grace period; clock continues to tick against them
- If they return: game continues
- If they don't return: game ends, status `abandoned`, **opponent forfeits payout**, full refund to creator
- Their trust score takes a hit

If the creator disconnects mid-game:

- Same grace period
- If they don't return: game ends, status `creator_abandoned`, **opponent still gets paid** (they completed their commitment)
- Creator's trust score takes a hit

This asymmetry is important: the opponent's payment is for _being available and playing the game_. If the creator wastes their time by disconnecting, the opponent has still delivered.

### Game start position rule

The opponent must play the _exact published position_ with normal chess rules from that point onward. They cannot "deviate" because the position is the starting state. They must make legal moves. If a server-side bug somehow allows an illegal state, the match is aborted and refunded.

### Multi-game challenges

When `games_requested > 1`:

- Each game is a separate match row
- Each game settles independently
- The challenge stays `open` (with `games_completed` incrementing) until all games complete
- The same opponent can play all games, or different opponents can pick up different games (depending on creator preference flag)

---

## 9. Rating System

### Skill rating

**Algorithm:** Glicko-2 (Lichess uses this; well-documented; robust with sparse data).

**Parameters (initial):**

- Default rating: 1500
- Default RD (rating deviation): 350
- Default volatility: 0.06
- System constant τ: 0.5
- RD floor: 50 (don't let high-volume players drop below)

**Initialization with linked external accounts:**

When a user connects a Lichess or chess.com account, use their external rating as a Bayesian prior. If their Lichess blitz rating is 1800, their Chessco initial skill rating is biased toward 1800 with a moderate RD. After 10–20 paid games on Chessco, the prior fades.

**Per-time-class ratings:** Maintain separate ratings for bullet, blitz, rapid, classical. The same player has 4 numbers.

**Display:** Show the active time class's rating prominently. Show the others on hover.

### Rating updates

Only **completed paid games** affect skill rating. Abandoned games, refunded games, and disputed games do not.

For each completed match:

1. Compute Glicko-2 update for both players
2. Write to `rating_history` with before/after values
3. Update `ratings.skill_rating`

### Provisional badge

If `skill_rd > 100`, display rating with a `?` suffix to indicate uncertainty.

---

## 10. Trust Score

### Scale

0–100, integer. Default 50 for new users.

### Tiers

| Tier     | Range        | What it unlocks                                                                     |
| -------- | ------------ | ----------------------------------------------------------------------------------- |
| New      | 50 (default) | Browse only, cannot publish challenges, can accept low-fee challenges only ($1 max) |
| Bronze   | 50–64        | Accept challenges up to $2, publish challenges up to $1                             |
| Silver   | 65–79        | Accept any, publish up to $5                                                        |
| Gold     | 80–94        | Publish up to $20                                                                   |
| Platinum | 95–100       | Publish up to $100, eligible for tournament features                                |

### Components & weights

Recomputed after each marketplace event. Pseudocode:

```
trust_score = clamp(
  50
    + 0.5 × paid_games_completed                    # cap at +30
    − 5 × paid_games_abandoned                      # severe
    − 2 × refunds_denied_as_creator                 # filed bad-faith refund
    + 1 × refunds_denied_as_respondent              # accusation didn't stick
    − 10 × fairplay_flags_confirmed                 # cheating
    − 3 × fairplay_flags_pending                    # under review
    + 2 × external_accounts_verified                # max +6 across platforms
    + 5 × kyc_completed                             # KYC done
    + 0.1 × days_since_account_creation             # cap at +10
  , 0, 100
)
```

Exact weights are tunable; values above are starting points.

### Decay & recovery

- Trust score decays slowly toward 50 if inactive for > 90 days (1 point/week).
- A single confirmed cheating flag drops to 0 immediately and permanently bans paid play.
- Three abandons in 30 days suspends paid-play eligibility for 7 days.
- Refund-request privilege is suspended for 30 days if 3+ refund requests are denied in a 90-day window.

### Display

- Show trust tier prominently (badge: New / Bronze / Silver / Gold / Platinum)
- Hide the raw 0–100 score from other users (only shown to self)
- Show "X paid games completed" as the public proxy

---

## 11. Refund System

### Valid reason codes (categorical, not free-text)

| Code                           | Description                                                 | Auto-resolution                                 |
| ------------------------------ | ----------------------------------------------------------- | ----------------------------------------------- |
| `opponent_abandoned`           | Opponent disconnected and didn't return within grace period | Auto-approve (system already triggered refund)  |
| `opponent_didnt_play_position` | Game state diverged from published FEN at start             | Auto-approve if telemetry confirms; else manual |
| `engine_assistance_suspected`  | Move accuracy abnormally high                               | Manual review, anti-cheat queue                 |
| `harassment`                   | Chat abuse or threats                                       | Manual review                                   |
| `technical_failure`            | Platform crashed, lost connection through no fault of own   | Manual review with logs                         |
| `other`                        | Free-text required                                          | Manual review                                   |

**Invalid reason codes** (rejected at UI level):

- "I lost"
- "Opponent played too well"
- "I didn't enjoy it"
- "I changed my mind"
- "The position was harder than I thought"

The UI presents only the valid reason codes as buttons. There is no free-text option that bypasses categorization.

### State machine

```
refund_request.status:
  open → (auto rule fires) → auto_approved → reversed (ledger reversal complete)
  open → under_review → (admin) approved → reversed
  open → under_review → (admin) denied
```

### Auto-resolution rules

Run when refund request is created:

1. `opponent_abandoned` + telemetry confirms: auto-approve, ledger reverse, opponent trust hit.
2. `opponent_didnt_play_position` + game's `initial_fen` ≠ challenge's `fen`: auto-approve.
3. Any reason filed by a user whose refund-request privilege is suspended: auto-deny.

### Manual review queue

Admin dashboard route. Each ticket shows:

- Match context (FEN, PGN, time control, both players' trust tiers and history)
- Reason code + detail
- Telemetry log
- Evidence uploads
- Action buttons: Approve, Deny, Request more info, Escalate

SLA targets:

- Auto-resolution: < 60 seconds
- Manual review for engine cases: 24–72 hours (because anti-cheat workflow is involved)
- Manual review for everything else: 48 hours

### Refund execution

When approved:

1. Reverse `match_escrow` ledger entries
2. Credit refund to user wallet
3. If `engine_assistance_suspected` approved: opponent's payout is reversed even after settlement (this is why ledger entries have `reversible_until`); apply confirmed fairplay flag to opponent

### Refund abuse prevention

- 3 denied refunds in 90 days → 30-day refund-filing suspension
- Each denied refund: trust −2
- Each approved refund: no trust penalty (legitimate complaint)
- Sustained pattern of denials → manual account review

---

## 12. Anti-Cheat

The hardest part of the marketplace, treated as a co-equal product surface, not a phase-6 add-on.

### Detection stack

**Live (during paid games):**

- Tab visibility tracking (`visibilitychange` events sent over WebSocket)
- Window blur/focus events
- Mouse movement entropy
- Paste detection on the board (any paste action flagged)
- DevTools open detection (limited, but log when possible)
- Move time variance vs. position complexity (engine workers compute "complexity" score per position; we compare against player's move times)

**Post-game (automated):**

- **Engine correlation:** Run their moves through Stockfish at multiple depths (12, 18, 25). Compute "engine match rate" — % of moves that match the engine's top choice. Compare against the rating-appropriate baseline (a 1500 should match top engine choice in ~40% of moves; if they match in 85%, that's a flag).
- **Centipawn loss profile:** Their average cp loss should match their rating distribution. Outliers flag.
- **Move time vs. complexity:** Did they think for 0.5s on the only-correct hard move and 30s on the obvious recapture? Inverted thinking patterns are a flag.

**Behavioral over time:**

- New-account fast-rise: account ≤ 30 days old climbing rating quickly while accepting paid games → flag for sandbagging review
- Rating-platform discrepancy: external Lichess rating 1500, Chessco paid-game performance 2200 → flag

**Manual signals:**

- Player report (button in game room and post-game): "I think my opponent was cheating"
- All reports route to the queue; reporting users get trust+1 if their report is confirmed, no change if dismissed (avoid penalizing good-faith reports)

### Action stack

Severity-tiered:

| Signal level                 | Action                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1 (single weak signal)       | Log only                                                                                                                             |
| 2–3 (one strong or two weak) | Background review, no user-visible action                                                                                            |
| 4–5 (multiple strong)        | Paid-play suspended pending review, payouts withheld                                                                                 |
| 6+ or confirmed              | Permanent paid-play ban, all withheld payouts forfeited (returned to creators as refunds), trust → 0, optional public ban list entry |

### KYC gate

- Stripe Connect Express handles KYC on first payout request above $20 (configurable)
- Below that threshold, payouts allowed without KYC for low-trust testing
- Without KYC, accumulating earnings cap at $50 — must KYC to continue receiving

### Linked-account requirement for paid play

Both creator and opponent must have ≥ 1 verified external account (Lichess, chess.com, or FIDE) before participating in paid games. Verification = OAuth (Lichess) or bio-token paste (chess.com).

### Sandbagging defense

- External rating used as a Bayesian prior on skill rating (§9)
- Maximum 1.5× rating-band stretching beyond external rating (a 1500-rated external player cannot accept a 2200 challenge regardless of their Chessco rating)
- Rapid rating climb (more than 200 Glicko points in 50 games while playing paid) flags for review

---

## 13. Wallet & Payments

### Stripe Connect Express setup

- Platform: **Connected accounts of type Express** (Stripe handles KYC, dashboard, tax forms)
- Capabilities: `transfers`, `card_payments` (only on platform side, not on opponents)
- Onboarding flow: redirect to Stripe-hosted onboarding when user first requests a payout
- Webhooks: handle `account.updated`, `transfer.created`, `payout.paid`, `payout.failed`, `charge.dispute.created`

### Deposit flow

1. User initiates "Add funds" → select amount → Stripe Checkout (saved card) or Stripe Elements (one-time)
2. Stripe webhook `charge.succeeded` arrives
3. Ledger entries created:
   - Debit `stripe_clearing` (cash held by Stripe)
   - Credit user's `wallet` (available_cents)
4. User wallet UI updates via Realtime

### Withdrawal flow

1. User requests withdrawal → amount + payout method (already onboarded via Express)
2. Pre-checks: KYC complete, available balance sufficient, not under fairplay review hold
3. Stripe `transfer.create` from platform balance to connected account
4. Connected account auto-payout (per Stripe's default schedule, usually 2-day for US, varies by country)
5. Ledger entries:
   - Debit user's `wallet` (available_cents)
   - Credit `stripe_clearing` (offsetting the transfer)
6. Webhook `payout.paid` confirms; ledger reconciliation

### Escrow during a match

When a match is created:

- Debit user wallet → `escrow` account (full fee)
- On settlement: split escrow → platform_revenue (fee portion) + opponent wallet (payout portion)

The `escrow` ledger account aggregates all in-flight match funds across the platform. Reconcile daily: sum of all `escrow` ledger entries with no offsetting reversal must equal sum of `pending_cents` in all wallets.

### Platform fee

Configurable at the matches table level (snapshotted at match creation, not changed retroactively if global rate changes). Initial value: **15% of match fee** (subject to A/B testing).

### Withdrawal hold periods

| Trust tier   | Hold from earning to withdrawable |
| ------------ | --------------------------------- |
| New / Bronze | T+5 days                          |
| Silver       | T+3 days                          |
| Gold         | T+1 day                           |
| Platinum     | T+0 (immediate)                   |

This delay covers the refund review window plus dispute buffer.

### Dispute handling (Stripe chargebacks)

When a Stripe chargeback fires on a deposit:

1. Webhook `charge.dispute.created` received
2. Lock user account from new matches
3. Compute affected escrow / payouts and freeze any not yet withdrawn
4. Stripe dispute response managed manually (small volume initially)
5. If lost: user balance adjusted, ledger reversal

### Tax & reporting

- US users: Stripe issues 1099-K via Express for those who exceed reporting thresholds
- EU users: Stripe handles VAT MOSS where applicable
- Israel: consult with accountant; likely subject to standard business income reporting
- Platform-side: track all platform_revenue ledger entries for revenue recognition

---

## 14. Live Game Server

### Why separate from Vercel

Vercel functions are stateless and short-lived. Live chess games need:

- Long-lived WebSocket connections (5min–2hr+)
- Server-authoritative clocks (ticking down on the server, not the client)
- Sub-200ms move latency
- In-memory game state during play

Vercel cannot do this; serverless functions time out. The game server is a dedicated process.

### Architecture

- Single Fly.io app, 2–3 instances behind Fly's load balancer
- Each match is "owned" by one instance for its duration (sticky via match_id)
- Game state held in process memory + checkpointed to Redis every move
- On instance crash, another instance can resume from Redis state (game continues, brief reconnect blip)

### WebSocket protocol

Connection URL: `wss://gameserver.chessco.org/match/{match_id}?token={jwt}`

JWT carries `profile_id` and `match_id`; signed by web app, verified by game server. Includes short expiry.

Message types (JSON):

```
Client → Server:
  { type: "hello", clientTime: <ms> }
  { type: "move", san: "Nf3", uci: "g1f3", clientClock: 124300 }
  { type: "resign" }
  { type: "draw_offer" }
  { type: "draw_accept" }
  { type: "draw_decline" }
  { type: "chat", text: "good luck" }
  { type: "report", category: "engine_use" | "harassment" | "other", notes: "..." }
  { type: "ping" }

Server → Client:
  { type: "state", fen, pgn, whiteClock, blackClock, toMove, status }
  { type: "move_accepted", ply, san, whiteClock, blackClock }
  { type: "move_rejected", reason }
  { type: "opponent_move", ply, san, fen, whiteClock, blackClock }
  { type: "opponent_disconnected", graceUntil }
  { type: "opponent_reconnected" }
  { type: "game_end", result, termination, finalFen }
  { type: "chat", from, text }
  { type: "draw_offered", by }
  { type: "draw_declined", by }
  { type: "pong" }
  { type: "error", code, message }
```

### Clock authority

- Server holds authoritative clocks
- On each move accepted, server decrements the moving player's clock by `(server_received_at - server_last_move_at)`
- Clients render a smooth countdown from the last server-authoritative value; they do not drift the server
- Every 1 second, server broadcasts current clocks to both players for resync

### Move validation

- Server holds the game state via `chess.js` (or equivalent on the server side)
- Validates SAN/UCI legality
- Rejects illegal moves; client UI prevents most by validating locally first
- Trusts server response as authoritative

### Disconnect handling

- WebSocket disconnect detected by `close` or `error` event
- Server starts 60-second grace timer; clock continues to tick against the disconnected player
- If reconnect: resume, broadcast `opponent_reconnected`
- If timeout: end game, status `abandoned` (opponent disconnect) or `creator_abandoned` (creator disconnect), settlement runs per the asymmetric rule (§8)

### Spectator mode (Phase 5+)

- Read-only WebSocket subscribers can watch live matches with a 10-move delay (anti-coaching)
- Spectator list and chat are separate from player chat
- Verified spectators (trust tier ≥ silver) can spectate without delay

### Persistence

- Each accepted move written to `match_moves` (async, batched if needed)
- Final state written to `live_games` at game end
- PGN reassembled from `match_moves` on demand for the review page

---

## 15. AI Integration

### Where Claude is used

| Surface                        | Model         | Purpose                                          | Caching             |
| ------------------------------ | ------------- | ------------------------------------------------ | ------------------- |
| Player identification evidence | Haiku         | "Why we think this is the same player" prose     | Per-result, 24h     |
| Prep report executive summary  | Opus / Sonnet | Coach-style game plan                            | Per-report, 30 days |
| Prep report risk paragraphs    | Sonnet        | "Lines to avoid against this opponent"           | Per-report          |
| Style fingerprint description  | Haiku         | 1-paragraph stylistic description                | Per-player, 7 days  |
| Blog content drafts            | Sonnet        | First-draft generation (human edits)             | n/a                 |
| Knowledge base FAQ matcher     | Haiku         | Match user question to KB article                | n/a                 |
| In-app help chat               | Haiku         | Conversational support for non-billing questions | n/a                 |

### What Claude is **never** used for

- Chess analysis (Stockfish + engine workers only)
- Move recommendations beyond what Stockfish already computed
- Identification confidence scores (computed numerically, not by LLM)
- Wallet or payment logic
- Fairplay decisions
- Refund decisions
- Anything that can be hallucinated and have real-money consequences

### Prompt discipline

Every Claude call has:

- System prompt declaring it as a _coach_, _writer_, or _summarizer_ — never an analyst
- Explicit instruction not to invent moves, evaluations, or facts
- Structured input (JSON of computed findings) as the source of truth
- Output schema specified (JSON for structured outputs, markdown for prose)

Maintain a `prompts/` directory in the monorepo. Every prompt versioned (`prep_summary_v1.md`). Evals run on a held-out set whenever a prompt is changed.

### Cost management

- Cache aggressively (see table above)
- Use Haiku for short tasks; reserve Opus for prep summaries where quality matters
- Set per-user monthly Claude token budgets (subscribed users get higher caps)
- Monitor cost-per-report and adjust prompt length

---

## 16. Frontend — Application Pages

Routes (Next.js App Router):

### Authentication

- `/login` — email + magic link, Google OAuth, Apple OAuth
- `/signup` — email + password, country, date of birth, marketing consent
- `/onboarding` — multi-step wizard (link external accounts, complete profile, choose subscription)

### Core app

- `/dashboard` — landing post-login: active prep reports, open challenges, recent games, wallet balance, suggested actions
- `/scout` — player search
- `/p/[player_id]` — player profile
- `/reports` — list of own prep reports
- `/reports/[report_id]` — prep report viewer (with PDF download)
- `/reports/new` — start a new prep report (pick user player record + target)
- `/challenges` — marketplace lobby
- `/challenges/new` — create a challenge
- `/challenges/[challenge_id]` — challenge detail / accept flow
- `/matches` — list of own matches (active, pending, completed)
- `/matches/[match_id]` — match detail (live: game room; completed: review with engine analysis)
- `/game/[match_id]` — live game room (WebSocket connection to game server)
- `/practice` — drill mode (Maia opponent-style bot, no payment, subscription-gated)
- `/account` — profile settings, linked accounts, password, deletion
- `/account/wallet` — balance, transaction history, deposits, withdrawals
- `/account/subscription` — manage subscription tier
- `/account/kyc` — Stripe onboarding redirect
- `/account/fairplay` — own fairplay record (transparency)

### Admin (separate subdomain `admin.chessco.org`)

- `/admin` — overview dashboard
- `/admin/users` — user list, search, ban actions
- `/admin/matches` — match search, force-settle, force-refund
- `/admin/refunds` — refund queue
- `/admin/fairplay` — fairplay flag queue
- `/admin/finance` — ledger viewer, daily reconciliation, payout overrides
- `/admin/ingestion` — ingestion worker dashboards (FIDE, USCF, Lichess dumps)
- `/admin/content` — KB and blog CMS (or use a headless CMS — see §19, §20)

### Component design

Consistent across the app:

- **Dark mode default**, light mode optional. Chess players prefer dark; matches the "prep room" mood.
- **Cards everywhere.** shadcn/ui `Card` is the atomic unit. Avoid dense tables in primary views.
- **Sidebar nav on app pages.** Top-bar on marketing pages. Distinguish clearly.
- **Real-time updates** via Supabase Realtime: wallet balance, open challenges, match status, notifications. Use TanStack Query's `subscribe` patterns.
- **Loading states** are skeleton-driven (shadcn `Skeleton`). No spinners except on action buttons.
- **Empty states** carry a friendly explanation and CTA. Never an empty grid.
- **Error states** are recoverable. "Something went wrong" + retry button + support link.

---

## 17. Frontend — Marketing Site

Same Next.js app, different root layout. Public routes under `/`.

### Pages

- `/` — Home
- `/how-it-works` — three-feature walkthrough with animations
- `/pricing` — subscription + marketplace fee breakdown
- `/scout-preview` — public demo of player search (rate-limited, no real account needed)
- `/for-coaches` — coach use case page
- `/for-tournament-players` — OTB tournament prep use case
- `/about` — story, team, mission
- `/contact` — form + email + support hours
- `/blog` — blog index
- `/blog/[slug]` — article
- `/help` — knowledge base index
- `/help/[category]/[slug]` — KB article
- `/legal/terms` — Terms of Use
- `/legal/privacy` — Privacy Policy
- `/legal/refunds` — Refund Policy
- `/legal/fair-play` — Fair Play Policy
- `/legal/acceptable-use` — Acceptable Use Policy
- `/legal/cookies` — Cookie Policy
- `/legal/dpa` — Data Processing Addendum (downloadable, for B2B)
- `/security` — security overview page
- `/changelog` — product changelog

### Home page structure

1. **Hero** — Slogan + sub + CTA + video/animation of the prep loop
   - Slogan (lockup with logo): **Scout. Prepare. Win.**
   - Sub: _Find your next opponent's online games. Build a battle plan. Practice the exact positions that matter._
   - CTA: Start free / Watch demo (90s)
2. **The loop** — 5-step animated diagram of Scout → Find → Practice → Pay → Improve
3. **Feature 1 callout** — Player identification, with sample search animation
4. **Feature 2 callout** — Opponent prep report, with sample sunburst opening tree
5. **Feature 3 callout** — Sparring marketplace, with sample challenge cards (use marketplace sub-tagline here, not "Win")
6. **Social proof** — testimonials, titled-player endorsements (when available), press
7. **Pricing teaser** — three pricing tiers, link to full pricing
8. **FAQ** — 6 most common questions
9. **Final CTA**
10. **Footer** — sitemap, legal, social, language switcher

### Copywriting rules (mandatory)

These rules extend the forbidden vocabulary in §3:

- **"Scout. Prepare. Win." is the master tagline.** Use on prep-focused surfaces: home, scout, prep reports, blog, app dashboard. Lock it up with the logo.
- **Marketplace surfaces use a different sub-tagline.** Any page where match fees, payouts, or the act of playing for fees is visible (challenge lobby, create-challenge, game room, wallet) must use _"Practice the positions that matter"_ or equivalent. The word "Win" must not appear within two viewport-screens of any fee amount or payout amount. This protects the legal framing from §3.
- **The opponent is never "competing for" the fee.** They are "playing to complete the session." Copy must reflect this.
- **No outcome-conditional language** anywhere marketplace fees appear: avoid "earn by winning," "profit from your games," "compete for cash." Use "earn by completing sessions," "get paid to play prep positions," "sparring fees."

### Brand voice

- Direct, professional, no chess clichés ("battle," "warrior," "destroy your enemy" — banned)
- Confident without arrogance
- Specific over general ("Find their Caro-Kann score" over "Find their weaknesses")
- Targeted at adults who take chess seriously, not kids or casual players

### Design system

- **Typography:** Inter (UI) + Geist (display headlines). Both are Vercel-friendly defaults. Variable font weights.
- **Colors:**
  - Primary: deep slate (#0F172A bg in dark mode)
  - Accent: a chess-board-inspired warm amber (#EAB308 — board light squares vibe)
  - Surfaces: layered grays
  - Success / danger / warning per shadcn defaults
- **Iconography:** Lucide icons (already paired with shadcn)
- **Imagery:** Real chess boards photographed at angles, plus board diagrams. No stock photos of "diverse hands shaking over chess board."
- **Motion:** Subtle. Framer Motion fade-up on scroll, hover lifts on cards. Nothing flashy.

### Performance targets

- Lighthouse score ≥ 95 mobile and desktop on marketing pages
- LCP < 2.0s
- Marketing pages 100% statically rendered (SSG); only the app shell is dynamic
- Image optimization via Next.js `<Image>`

---

## 18. Blog Strategy

### Purpose

- SEO acquisition (target long-tail "how do I prepare for X" queries)
- Authority building in the chess preparation niche
- Top-of-funnel content marketing
- Reinforce the product loop (every article ends with a relevant CTA)

### Cadence

- 2 articles per week for first 6 months (24 weeks × 2 = 48 articles to build SEO base)
- Then 1 per week steady state

### Categories

| Category            | Examples                                                                             |
| ------------------- | ------------------------------------------------------------------------------------ |
| Opening prep guides | "How to play against the Caro-Kann Advance Variation"                                |
| Player profiles     | "Magnus Carlsen's white repertoire: what we can learn" (titled players only, public) |
| Tournament prep     | "How to prepare for a weekend open: a 5-day plan"                                    |
| Concept explainers  | "What is opening theory, and how much should you study?"                             |
| Tools & how-tos     | "How to find someone's chess.com account from their name"                            |
| Mistake patterns    | "Why amateurs lose with the King's Indian (and how to fix it)"                       |
| Time controls       | "Blitz vs rapid prep: what changes"                                                  |
| Case studies        | "How I used Chessco to win my club championship" (user stories)                      |

### SEO targets

Initial 50 keyword targets focused on:

- "How to prepare for [opponent / tournament / opening]"
- "[opening name] for [color]"
- "Chess.com vs Lichess [comparison]"
- "Find chess account by [name / country / club]"

### Tech

- Blog posts as MDX in the monorepo (`content/blog/*.mdx`) — simple, version-controlled, no CMS overhead initially
- Authors and tags as frontmatter
- RSS feed at `/blog/rss.xml`
- Schema.org Article markup for SEO
- Comment system: none initially. Maybe Cusdis or Giscus later.

### AI assist

- Use Claude Sonnet to generate first drafts from a structured outline
- Human editor (could be Boaz or freelance) reviews, fact-checks, edits voice, adds personal touches
- Never publish raw AI output — too risky for chess accuracy and brand voice

---

## 19. Knowledge Base

### Structure

`/help` index with categories. Each article: clear question-style title, 200–800 words, accompanying screenshots or short video clips.

### Categories & seed articles

**Getting started**

- What is Chessco?
- How to create an account
- How to link your Lichess account
- How to link your Chess.com account
- Understanding your dashboard

**Player discovery**

- How to search for a chess player
- What makes our matching confident?
- Why can't I find an anonymous player?
- How to opt in / opt out of being discoverable

**Preparation reports**

- How to build your first prep report
- Understanding the opening tree
- Exporting a prep report to PDF
- Refreshing a stale report

**Sparring marketplace**

- How sparring works
- How fees are calculated
- How to publish a position challenge
- How to accept a challenge
- What happens if my opponent disconnects
- Why is my payout delayed?

**Wallet & payments**

- Adding funds to your wallet
- Withdrawing your earnings
- Understanding KYC requirements
- Why was my deposit declined?

**Refunds**

- When can I request a refund?
- How long do refunds take?
- What happens if my refund is denied?

**Fair play**

- Our fair-play policy in plain English
- How we detect cheating
- What happens if I'm flagged
- How to report a player

**Account & privacy**

- Changing your password
- Deleting your account
- Downloading your data (GDPR)
- Privacy controls

### Tech

- Markdown files in repo, same MDX system as blog
- Search powered by a simple client-side index (Pagefind or Fuse.js)
- "Was this helpful?" thumbs widget on every article (logs to PostHog)
- Linked from in-app `?` icons on relevant pages

---

## 20. Legal Pages

All drafted by Boaz initially (you have experience here — GDPR DPA v4, Information Security Policy, NDA template), then reviewed by counsel before production launch. Use Israeli + EU + US-friendly templates.

### Required pages

#### Terms of Use (`/legal/terms`)

Sections:

1. Acceptance and changes
2. Eligibility (18+ for paid features, jurisdiction restrictions)
3. Account registration and security
4. Services description (preparation tools + sparring marketplace)
5. **Sparring marketplace rules** — emphasize completion-based payout, no result-conditional payment
6. Fees and payment
7. User-generated content (PGNs, chat, reports)
8. Prohibited conduct (cheating, harassment, illegal use)
9. Intellectual property (platform IP, user IP licensing)
10. Disclaimers (no guarantee of opponents, no chess training advice given as professional advice)
11. Limitation of liability
12. Indemnification
13. Dispute resolution (arbitration clause, choice of law — likely Delaware for US users, Israeli law for IL users, with EU-specific carve-outs)
14. Termination
15. Miscellaneous

#### Privacy Policy (`/legal/privacy`)

GDPR + CCPA compliant. Sections:

1. Data collected (account, gameplay, payment, analytics, fairplay telemetry)
2. How we use data (service provision, fraud prevention, AI training — opt-in only)
3. Legal bases (contract, legitimate interest, consent)
4. Sharing (Stripe, Supabase, Vercel, Anthropic, Lichess/chess.com, etc. — disclosed in subprocessor list)
5. International transfers (Standard Contractual Clauses)
6. Retention (per data category)
7. Rights (access, deletion, portability, objection, restriction)
8. Cookies (link to cookie policy)
9. Children (not for under 18)
10. Contact (DPO if appointed)

#### Refund Policy (`/legal/refunds`)

Plain-English version of §11. Lists valid refund reasons, ineligible reasons, refund process, timeline.

#### Fair Play Policy (`/legal/fair-play`)

Plain-English version of §12. Covers:

- No engine assistance during games
- No collusion / arranged outcomes
- No multi-accounting
- Detection methods (in general terms, not full disclosure)
- Consequences (graduated)
- Appeal process

#### Acceptable Use Policy (`/legal/acceptable-use`)

What users can't do beyond cheating:

- Harassment, hate speech, threats
- Impersonation
- Spam / scraping
- Reverse engineering
- Sharing accounts
- Identifying anonymous players without consent

#### Cookie Policy (`/legal/cookies`)

What cookies we use, categories, opt-out via cookie banner. Cookie banner UI required for EU users; consider using a managed service (Iubenda, Cookiebot) initially.

#### Data Processing Addendum (`/legal/dpa`)

Downloadable PDF for B2B users (coaches, schools, organizations that put students on the platform). Adapt the existing GDPR DPA v4 template from Foto Master with modifications for Chessco data flows.

### Implementation

- Each legal page MDX with version + effective date
- "Previous versions" link at bottom of each
- Update notifications via email when material changes
- Acceptance logged in `audit_logs` at signup + each material change

---

## 21. Email & Notifications

### Transactional emails (Resend)

| Trigger               | Template                                                     |
| --------------------- | ------------------------------------------------------------ |
| Account signup        | Welcome + verification                                       |
| Email change          | Verification                                                 |
| Password reset        | Reset link                                                   |
| Match accepted        | "Your challenge has been accepted, game starts in N seconds" |
| Match completed       | Result + earnings (opponent) / spend (creator)               |
| Refund filed          | Confirmation + timeline                                      |
| Refund resolved       | Decision + rationale                                         |
| Fairplay flag         | Initial notice with appeal info                              |
| KYC required          | "Complete KYC to withdraw"                                   |
| Deposit succeeded     | Receipt                                                      |
| Withdrawal initiated  | Confirmation + ETA                                           |
| Withdrawal completed  | Confirmation                                                 |
| Subscription renewed  | Receipt                                                      |
| Subscription expiring | 7-day, 1-day reminders                                       |
| Prep report ready     | "Your report on [opponent] is ready"                         |

### Lifecycle emails (Loops or Customer.io)

- Day 1: "Welcome" — link external accounts
- Day 3: "Try your first prep report" — if not done
- Day 7: "Did you find what you needed?" — feedback ask
- Day 14: "Subscribe to unlock full prep" — if free user
- Day 30 inactive: "Come back, here's what's new"
- Quarterly: digest of new features, top blog posts

### In-app notifications

- Bell icon in nav with notification list
- Categories: matches, payments, fairplay, system
- Real-time via Supabase Realtime
- Read state tracked
- Email + in-app preferences in `/account/notifications`

---

## 22. Admin & Operations

### Admin dashboard (`admin.chessco.org`)

Role-gated. Required surfaces:

**Overview**

- Active users (DAU/WAU/MAU)
- Live matches now
- Open challenges
- Refund queue depth
- Fairplay queue depth
- Today's revenue, payouts, refunds

**User management**

- Search by handle / email / id
- View profile, ratings, trust score, match history, wallet, fairplay history
- Actions: warn, suspend paid play, ban, force-KYC, manually adjust balance (with reason + audit log)

**Match management**

- Search by match id, user, status
- View full game state, telemetry, PGN
- Actions: force-settle, force-refund, abort, override fairplay flag

**Refund queue**

- Pending refunds with all evidence
- Filter by reason code, age
- Bulk actions for auto-approvable patterns

**Fairplay queue**

- Pending flags sorted by severity
- Review interface with engine correlation analysis, telemetry replay, game replay
- Decision: confirm / dismiss with notes

**Finance**

- Ledger viewer with filters
- Daily reconciliation report (escrow balance vs sum of pending_cents)
- Stripe sync status
- Manual transactions (with audit log)

**Ingestion**

- FIDE / USCF / Lichess dump run history with metrics
- Manual-trigger buttons
- Per-federation health (last successful run, error rates)

**Content**

- Blog post draft / publish
- KB article draft / publish
- Legal page versioning

### Manual operations runbooks

Maintain `/ops/runbooks/` in the repo as MDX:

- `fide-ingestion.md`
- `engine-cheating-investigation.md`
- `payment-dispute.md`
- `account-takeover.md`
- `gdpr-data-request.md`
- `account-deletion.md`
- `database-restore.md`
- `incident-response.md`
- `daily-finance-reconciliation.md`

---

## 23. Monitoring & Analytics

### Error tracking

- Sentry on web, gameserver, workers
- Source maps uploaded on build
- Performance tracing on critical paths (game start, match settlement, prep report generation)
- Alerts: error rate spike, error rate per release, p95 latency degradation

### Product analytics

- PostHog: event tracking, funnels, feature flags, session replay (sampled)
- Key events:
  - `signup_completed`
  - `external_account_linked`
  - `prep_report_started`
  - `prep_report_viewed`
  - `challenge_published`
  - `challenge_accepted`
  - `match_completed`
  - `refund_filed`
  - `withdrawal_initiated`
  - `subscription_started`

### Business analytics

- Daily ETL from Postgres to a small analytics DB (could just be a separate Supabase project with read-replica)
- Metabase or Hex for dashboards
- Track: MRR, ARPU, conversion funnel, match volume, take rate, refund rate, fairplay rate, churn

### Infrastructure monitoring

- BetterStack for uptime checks (every 60s on critical routes)
- Vercel native metrics
- Fly.io metrics (game server CPU, memory, websocket connection count)
- Upstash dashboard for Redis
- Supabase observability for DB

### Alerts to Slack

- Error rate > threshold
- Game server CPU > 80%
- Pending refund queue > N items
- Daily reconciliation mismatch
- Stripe webhook failure
- Inngest workflow failure
- FIDE ingestion failure or unexpected delta

---

## 24. Security & Compliance

### Authentication

- Supabase Auth with email + OAuth (Google, Apple)
- 2FA optional for users, **mandatory for admins**
- Session timeout: 30 days idle
- Recently authenticated requirement for: changing email, requesting withdrawal, deleting account

### Authorization

- Supabase Row-Level Security on every table
- Users can only read/modify their own rows except for the explicitly public surfaces (player profiles, challenge lobby, federation player records)
- Admin queries via dedicated service role, audit-logged

### Secrets

- All API keys in Vercel env (production), GitHub Secrets (CI), .env.local (dev)
- Rotate: monthly for sensitive (Stripe, Anthropic), quarterly for others
- No secrets in source code, ever

### Data retention

- Active accounts: data retained while account is active
- Closed accounts: anonymized after 30 days (handle replaced, email scrubbed, but games kept for opponent integrity)
- Fairplay logs: kept for 2 years for repeat-offender detection
- Financial records: kept for 7 years (tax requirement)
- Audit logs: kept for 2 years minimum

### GDPR compliance

- Data subject requests handled via `/account` (download my data, delete my account)
- 30-day response SLA
- Subprocessor list maintained on `/legal/subprocessors`
- DPA available for B2B

### Penetration testing

- Annual third-party pen test (budget for $5–10k)
- Bug bounty program later (HackerOne) once volume justifies

### Backups

- Supabase automatic daily backups, retained 7 days on starter plan; upgrade for longer retention before launch
- Manual monthly export to encrypted offsite storage (S3 with versioning)
- Quarterly restore drills

### Incident response

- Documented runbook
- Single point of contact rotating on-call
- Communication template for user-facing incidents

---

## 25. Phased Roadmap

Estimated timelines assume a small team (1–2 full-stack engineers + 1 part-time designer + Boaz as PM).

### Phase 0 — Foundation (5–7 weeks)

**Goal:** A user can sign up, link external accounts, see their own games, and search the federation player database.

- Monorepo setup, CI, environments
- Supabase project, full schema migrations including `federations` and `federation_players`
- Auth + onboarding
- Lichess OAuth + chess.com bio-token verification
- **FIDE ratings list ingestion worker** (the canonical identity anchor — see separate `fide-ingestion-spec.md`)
- USCF top-ratings list ingestion (if scope allows; can slip to Phase 1)
- Federation player search (`/scout` MVP — name + country fuzzy match against `federation_players`)
- PGN import worker for the user's own games (Lichess + chess.com)
- Basic profile page with own game list
- Marketing home page (placeholder)

**Out of scope:** prep reports, online-account matching, marketplace, payments.

**Why FIDE first.** The federation list is the anchor for everything in Feature 1. It's small (~400k records), well-structured, free, and unblocks all subsequent identification work. Without it, the system has no way to ground "real-world player" → "online account" matches.

### Phase 1 — Identification + opponent prep MVP (8–10 weeks)

**Goal:** A user can find a public player and request a prep report against them.

- **Lichess monthly DB dump ingestion** (filtered to rated games ≥ 1500, last 24 months)
- Chess.com PubAPI on-demand player fetch + cache
- Position interning + per-player stats aggregation
- Online-account matching pipeline (Stage 2 of §6 — fuzzy handle search + rating-band filter)
- Stylometric verification (engineered features only; embedding training deferred to Phase 2)
- Stockfish workers + batch analysis
- Opening tree construction
- Leak detection algorithm
- Prep report generation (structured findings)
- Claude integration for narrative layer
- PDF export
- Prep report viewer UI
- Subscription gate (Stripe Billing — simpler than Connect)

**Phase 1 ships as a paid product.** This is the wedge: discovery + prep together, in one tool, against verified OTB players. Validate willingness to pay before building the marketplace.

### Phase 2 — Identification depth (6–8 weeks)

**Goal:** Identification works against partially anonymous online accounts, not just OTB-anchored players. Style fingerprint becomes a verifier and an explorer.

- Learned embedding model training pipeline (offline)
- Vector index in pgvector (HNSW)
- Stylometric verification integrated into the Stage 3 ranking
- "Find unrated lookalikes" — given an anchor, find similar online accounts that may belong to the same person
- Style fingerprint UX polish (radar chart, prose summary, sample-game upload to compare)
- Privacy / opt-in controls (formalize §6 privacy defaults in product UI)
- Player profile page polish
- Federation browse mode (`/scout/federation/{id}` ranked lists — also valuable for SEO)

### Phase 3 — Marketplace MVP (no real money) (8–10 weeks)

**Goal:** Internal users can publish challenges and play them; no payments yet.

- Game server (Fly.io)
- WebSocket protocol implementation
- Challenge creation flow
- Lobby
- Match acceptance + game room
- Live game persistence
- Post-game review with engine analysis
- Anti-cheat telemetry collection (passive — log only, no actions)

### Phase 4 — Real payments (6–8 weeks)

**Goal:** Marketplace goes live with real money for selected jurisdictions.

- Stripe Connect Express integration
- Wallet UI
- Deposit / withdrawal flow
- KYC gating
- Double-entry ledger + reconciliation
- Refund system + admin queue
- Trust score implementation
- Glicko-2 rating implementation
- **Legal review and sign-off** before launch

Soft launch to Israel + EU only. US delayed pending state-by-state legal review.

### Phase 5 — Anti-cheat & trust hardening (6–8 weeks)

**Goal:** Platform is trustworthy enough for higher-volume paid play.

- Engine correlation post-game analysis
- Fairplay flagging system
- Admin fairplay queue
- Sandbagging detection
- KYC hard gates
- Hold periods enforced
- Public fairplay reporting / annual transparency report

### Phase 6 — Style-mimicking bots & polish (8–10 weeks)

**Goal:** Differentiated practice features that don't require paid opponents.

- Maia fine-tuning pipeline per player
- Drill mode against opponent-style bots
- Spectator mode
- Coach accounts (multi-student dashboards)
- OTB tournament prep mode (FIDE integration)

### Phase 7+ — Scale, internationalization, ecosystem

- Localized UI (Hebrew, Spanish, German, French, Russian)
- Mobile app (React Native, shared logic)
- Tournament partnerships
- Streaming integrations
- API for chess content creators

---

## 26. Risk Register

| Risk                                                        | Probability | Impact     | Mitigation                                                                                                     |
| ----------------------------------------------------------- | ----------- | ---------- | -------------------------------------------------------------------------------------------------------------- |
| Gambling regulation in target market                        | Medium      | Severe     | Completion-based payout structure; legal review per jurisdiction; geo-block where unclear                      |
| Engine cheating destroys trust                              | High        | Severe     | Multi-layer anti-cheat from launch; hold periods; KYC; linked-account requirement                              |
| Lichess / chess.com API access changes                      | Low         | Medium     | Cache aggressively; user uploads as fallback; monthly DB dumps as backbone                                     |
| Stripe rejects platform classification                      | Medium      | Severe     | Use established services MCC; Stripe contact Mitch involved early; have backup processor (Adyen, Checkout.com) |
| Player identification doxxing complaint                     | Medium      | High       | Default opt-in only; aggressive delist; explicit ethical policy                                                |
| AI hallucination in prep reports                            | Medium      | Medium     | LLM never generates chess content directly; strict prompt discipline; evals                                    |
| Game server outage during paid match                        | Low         | Medium     | Multi-instance; auto-resume from Redis; full refund on technical failure                                       |
| Sandbagging                                                 | High        | Medium     | External rating prior; rating-band stretching limits; review queue                                             |
| Withdrawal fraud (stolen card → deposit → match → withdraw) | Medium      | High       | Hold periods; trust-tier withdrawal caps; KYC gates; Stripe Radar                                              |
| Low marketplace liquidity (no opponents)                    | Medium      | High       | Seed with paid sparring partners (FM/IM contractors); subsidize early payouts                                  |
| Customer support overload                                   | High        | Low (each) | Aggressive KB; auto-resolution for refunds; in-app help chat with Haiku                                        |
| Storage scale (games corpus) exceeds Supabase tier          | Medium      | Medium     | Partition `games` by month from day one; plan to split corpus to dedicated Postgres if needed                  |

---

## 27. Open Decisions

Decisions Boaz needs to make before or during development:

1. **Trademark + .com acquisition** — Name (Chessco), primary domain (chessco.org), and slogan (Scout. Prepare. Win.) are locked. Still open: trademark search and registration in launch jurisdictions (IL, EU, UK, US); whether to acquire chessco.com if available (premium domain — likely worth it if price reasonable).
2. **Entity structure** — separate company (like Slokoto spinout), Foto Master subsidiary, or solo founder? Affects cap table, tax, employee equity.
3. **Co-founders** — solo or recruit a CTO / chess product expert?
4. **Funding** — bootstrap from Foto Master cashflow, raise pre-seed, or SAFE round (like Slokoto's $2.5M)?
5. **Pricing**
   - Subscription tier(s) and prices (Solo / Team-like structure)
   - Marketplace fee % (10% / 12% / 15%?)
6. **Initial launch jurisdictions** — Israel only, IL+EU, IL+EU+UK?
7. **Brand voice gender** — direct/intense (think: Whoop) or friendly/aspirational (think: Lichess)?
8. **Coach accounts** — Phase 1 or Phase 5+?
9. **OTB / FIDE focus** — central to product or adjacent niche?
10. **AI model choice** — commit to Anthropic, or also use OpenAI for redundancy?

---

## 28. Developer Handover Notes

### Repository layout (proposed)

```
chessco/
├── apps/
│   ├── web/                     # Next.js — marketing + app + admin
│   ├── gameserver/              # Node WebSocket server
│   └── workers/                 # Inngest functions
├── packages/
│   ├── db/                      # Drizzle schema + migrations
│   ├── types/                   # Shared TypeScript types
│   ├── chess-core/              # PGN, FEN, engine helpers
│   ├── ai/                      # Claude prompt library + helpers
│   ├── ui/                      # shadcn components + theme
│   └── analytics/               # Event tracking helpers
├── content/
│   ├── blog/                    # MDX blog posts
│   ├── kb/                      # MDX KB articles
│   └── legal/                   # MDX legal pages
├── ops/
│   ├── runbooks/                # Operational runbooks
│   └── prompts/                 # Versioned Claude prompts
├── .github/workflows/           # CI/CD
├── turbo.json
├── pnpm-workspace.yaml
└── README.md
```

### Conventions

- **TypeScript strict** everywhere
- **No `any`** — use `unknown` + narrowing
- **Zod schemas** at every API boundary
- **Server actions for mutations** in Next.js where possible
- **Tests:** Vitest for units, Playwright for E2E on critical flows (signup, match flow, payment flow)
- **Pre-commit:** ESLint + Prettier + typecheck via Husky + lint-staged
- **PR template** requires: description, screenshots if UI, migration safety check, perf impact

### Initial sprint priorities

Week 1–2: Auth, DB schema (incl. federation tables), monorepo, deploy pipeline.
Week 3–4: External account linking, own-game import.
Week 5–6: FIDE ingestion, federation `/scout` MVP, profile pages, basic UI shell.

### Key technical decisions to lock early

- Drizzle vs Prisma — recommendation: Drizzle for SQL transparency in analytical queries
- Next.js server actions vs separate API routes — recommendation: server actions for app mutations, separate routes for game server / Stripe / Inngest webhooks
- Job framework — recommendation: Inngest (good Next.js DX, observability)
- Email — recommendation: Resend transactional + Loops lifecycle

### Estimated build cost

Phases 0–4 to revenue-generating MVP:

- ~32–40 weeks of engineering at 1–2 FT engineers
- ~$80–120k in engineering cost (depending on location)
- ~$5–10k legal (initial + Phase 4 sign-off)
- ~$5k design (one-off + retainer)
- ~$3–8k infra during build (mostly Vercel + Supabase + Anthropic credits)

Phase 5–6 add another 14–18 weeks.

---

## 29. Appendices

### A. Glossary

- **Centipawn (cp):** 1/100 of a pawn unit, the engine's evaluation precision.
- **Engine:** Stockfish, the open-source chess engine used for analysis.
- **ECO:** Encyclopedia of Chess Openings classification (A00–E99).
- **FEN:** Forsyth-Edwards Notation, the standard text representation of a chess position.
- **Glicko-2:** A rating system that improves on Elo by tracking uncertainty (RD) and volatility.
- **Maia:** Open-source neural-net chess engine designed to play like specific rating levels.
- **PGN:** Portable Game Notation, the standard text format for full chess games.
- **pgvector:** PostgreSQL extension for vector similarity search.
- **Ply:** A single half-move (one player's move). A full move is 2 ply.
- **RD:** Rating Deviation in Glicko-2; lower = more confident rating.
- **SAN:** Standard Algebraic Notation, the human-readable move format ("Nf3").
- **UCI:** Universal Chess Interface format ("g1f3"); used between engines.

### B. Reference links

- Lichess API docs: https://lichess.org/api
- Chess.com PubAPI docs: https://www.chess.com/news/view/published-data-api
- Glicko-2 paper: http://www.glicko.net/glicko/glicko2.pdf
- Maia: https://maiachess.com / https://github.com/CSSLab/maia-chess
- Stockfish: https://stockfishchess.org
- shadcn/ui: https://ui.shadcn.com
- Supabase docs: https://supabase.com/docs
- Stripe Connect docs: https://stripe.com/docs/connect
- FIDE downloads: https://ratings.fide.com/download.phtml

### C. Competitive landscape

#### Direct competitor: SnoopChess

> Internal teardown with our specific differentiators lives in [`docs/competitors.md`](competitors.md). The summary below stays public-facing.

**URL:** snoopchess.com
**Positioning:** "Out-Prepare your Chess Opponent" — chess preparation software focused on player discovery.
**Stack tells:** Java backend (`.jsp` extensions on all routes); ratings tables structured per-federation; JS-rendered frontend.
**Scope of product:**

- Player discovery only (our Feature 1)
- Input: real name, country, FIDE/USCF rating, federation
- Output: matched Lichess and chess.com accounts + basic opening analysis
- Marketing claims: "billions of games and millions of accounts" indexed from Lichess and chess.com; federations covered include FIDE, USCF, and many national bodies
- Federation ranking pages exposed publicly (also valuable for SEO)
- Freemium with login wall

**What SnoopChess validates for Chessco:**

- Name-anchored matching against official federation rating lists is the correct architectural approach — this is why our spec changed in v1.1 (see §6)
- Federation-by-federation indexing is the right organizing principle for the player database
- Per-federation public ranking pages drive SEO and discovery (we should mirror this — see Phase 2)
- The market for chess preparation software exists and is willing to pay

**What SnoopChess does NOT do (Chessco's wedge):**

- No comparison against the user's own repertoire
- No prep report / battle plan / recommended lines (our Feature 2)
- No practice mode against opponent-style bots
- No marketplace / paid sparring (our Feature 3)
- No live games of any kind
- Discovery is one-way (real identity → online accounts only; no reverse, which is also our policy)

**Strategic implication:** Do not try to out-corpus SnoopChess on raw game count. Match them on federation coverage and matching accuracy, then race past them on Feature 2 (prep reports) and Feature 3 (marketplace). The user value is not "I found their chess.com profile" — chess.com itself shows the profile once you have the handle. The value is "I now have a plan to play them tomorrow, and I can practice the exact positions tonight."

#### Adjacent / non-overlapping products

- **Lichess** — free, huge user base, basic analysis tools (Lichess Studies, opening explorer). No per-opponent prep. The open chess platform.
- **Chess.com** — paid, large user base. "Insights" feature gives self-analysis. No opponent prep. Coaching marketplace exists but is unrelated to ours.
- **ChessBase** — desktop software (~$300+) with the deepest professional prep tooling. Mega Database license required for opponent games. Aimed at masters and serious tournament players. Powerful but not web-native, not consumer-priced, not collaborative.
- **Aimchess** — closest to Feature 2 conceptually, but self-improvement focused (analyses your own games to find your weaknesses), not opponent prep.
- **ChessTempo** — tactics training focused. No prep workflow.
- **Decode Chess** — engine-explanation focused for amateurs. Not prep.
- **Listudy / Chessbook / Chessable** — opening repertoire study tools. Build/memorize your own repertoire. Not opponent-specific.

#### Chessco's strategic position

Chessco is the **only product** that combines: federation-anchored player discovery (SnoopChess-grade) + per-opponent prep reports (ChessBase-grade, but web-native and consumer-priced) + sparring marketplace (no comparable product exists). The integrated loop — Scout → Prepare → Win — is the differentiator. No single competitor covers more than one of the three.

### D. Document changelog

- v1.0 (2026-05-11): Initial draft for developer handover.
- v1.1 (2026-05-11): Locked name (Chessco), domain (chessco.org), slogan (Scout. Prepare. Win.). Added federations + federation_players + federation_rating_snapshots tables to §5. Restructured §6 Feature 1 around name-anchored identification (three-stage: identity anchor → candidate handles → stylometric verification), informed by SnoopChess's product. Updated §17 with copywriting rules separating master tagline from marketplace surfaces. Reordered roadmap: Phase 0 now includes FIDE ingestion; Phase 1 ships identification + prep together; Phase 2 is identification depth (embeddings, anonymous-account discovery). Expanded Appendix C with full competitive landscape including SnoopChess profile.

---

**End of document.**
