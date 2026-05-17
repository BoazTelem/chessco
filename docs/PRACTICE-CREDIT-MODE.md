# Practice — casual vs credit modes

Product spec for the bot-practice game modes. Sister to
[MAIA-INFERENCE.md](./MAIA-INFERENCE.md) (HTTP contract) and
[MAIA-DEPLOYMENT.md](./MAIA-DEPLOYMENT.md) (service deployment).

---

## Three surfaces, two modes

| Surface             | Bot                                              | Default mode                  | Credit mode availability                                                    |
| ------------------- | ------------------------------------------------ | ----------------------------- | --------------------------------------------------------------------------- |
| `/practice/drill`   | Maia ladder, position drilled from a prep report | **Casual only** — always free | Never. Drill is a learning loop, not competition.                           |
| `/practice/sandbox` | Maia ladder (1500 / 1700 / 1900) full game       | Casual                        | Available only when **chosen Maia rating ≥ user's verified rating**         |
| `/prepare/otb`      | Maia fine-tuned on a specific opponent (Phase B) | Casual                        | Available only when **opponent's verified rating ≥ user's verified rating** |

### Why drill is always free

A drill is "I have a leak; let me play through this position 10 times
against a coach-bot." Attaching credit risk to a teaching tool taxes
the wrong behavior — repetition becomes financially scary, so users
practice less. Drill = no stakes.

### Why credit mode requires bot rating ≥ user rating

A user rated 1500 picking the Maia-1300 ladder and farming credits is
the obvious abuse. Two ways to kill it: auto-match the bucket (annoying

- fragile), or **gate credit availability on the rating differential**.
  We go with the gate.

Result: users _can_ pick a weaker bucket — for warm-up, fun, ego — but
they can't _earn credits_ while doing it. Picking a same-or-stronger
bucket is the only way to play for stakes; that's exactly the focus we
want from the mechanic.

---

## Credit-delta rules

| Outcome                                                                    | Casual mode | Credit mode                     |
| -------------------------------------------------------------------------- | ----------- | ------------------------------- |
| User wins                                                                  | +0 credits  | **+1 credit**                   |
| User loses (mate, resign, timeout)                                         | 0           | **−1 credit**                   |
| Draw (any FIDE rule: stalemate, threefold, 50-move, insufficient material) | 0           | **0 credits**                   |
| User abandons (disconnect > N moves, no return)                            | 0           | **−1 credit (treated as loss)** |

A credit-mode game cannot begin if the user's credit balance < 1.
Failing the rating-floor check downgrades the offer to casual silently
in the UI (no stake selector shown).

### Why no draw incentive

Maia plays naturally — it's not optimized to defend draws. In practice
draws are < 5% of bot games at these rating levels. Paying out on draws
would be noise; it also opens a side-channel where someone could play
for repetition. Zero on draw is clean.

---

## Verified-rating sourcing

The "user's verified rating" is the **highest verified Glicko or Elo
across the user's linked accounts**, scoped to the time class of the
practice game:

| Time class | Source priority                                     |
| ---------- | --------------------------------------------------- |
| bullet     | chess.com bullet > lichess bullet > FIDE blitz      |
| blitz      | chess.com blitz > lichess blitz > FIDE blitz        |
| rapid      | chess.com rapid > lichess rapid > FIDE rapid        |
| classical  | FIDE standard > chess.com daily > lichess classical |

The data is already in `external_accounts` (lichess + chess.com ratings
per time class) and `federation_players` (FIDE), pulled by the existing
account-link + federation-ingest pipelines.

**Edge case: user has no verified rating.**
Refuse credit mode entirely. The first credit-mode game requires at
least one platform account linked. Surface a "Link a chess.com or
lichess account to unlock credit-mode practice" CTA. This also dovetails
with the user-handle linking task already in flight per memory.

**Edge case: rating is unknown for the chosen time class.**
Same: refuse credit mode for that time class until the user has played
enough rated games on a linked platform to have a rating in that
bucket. Fall back to casual.

---

## Schema interaction

Credit deltas write to `credit_ledger_entries` (existing table, see
[packages/db/src/schema.ts:701](../packages/db/src/schema.ts)). Two new
category values to add:

```diff
 category: text('category')
   .$type<
     | 'link_bonus'
     | 'challenge_reserve'
     | 'challenge_refund'
     | 'challenge_consume'
     | 'manual_adjustment'
     | 'referral_bonus'
     | 'prep_leak_reveal'
     | 'practice_reward'
+    | 'practice_bot_win'
+    | 'practice_bot_loss'
     | 'subscription_grant'
     | 'cycle_expiry'
   >()
   .notNull(),
```

And a new value for `referenceType`: `'practice_bot_game'`. The
`referenceId` is the game id (we'll add a `practice_bot_games` table —
see "Persistence" below).

`practice_reward` (existing) is reserved for the older "earn credits by
completing N drills" loop; keep it separate from the win/loss accounting
so reports stay clean.

### `practice_bot_games` table (new)

```sql
CREATE TABLE practice_bot_games (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  surface text NOT NULL CHECK (surface IN ('sandbox', 'otb')),
  bot_kind text NOT NULL CHECK (bot_kind IN ('ladder', 'opponent_individual')),
  bot_rating integer NOT NULL,           -- 1500/1700/1900 for ladder; opponent's verified rating for individual
  user_rating integer NOT NULL,          -- snapshotted at game start
  weights_id uuid NOT NULL REFERENCES maia_weights(id),
  time_class text NOT NULL CHECK (time_class IN ('bullet','blitz','rapid','classical')),
  time_control text NOT NULL,            -- '5+0', '15+10', etc.
  mode text NOT NULL CHECK (mode IN ('casual', 'credit')),
  result text CHECK (result IN ('user_win', 'user_loss', 'draw', 'abandoned')),
  result_reason text,                    -- 'checkmate', 'resign', 'timeout', 'stalemate', '50_move', 'threefold', 'insufficient_material', 'disconnect'
  pgn text,
  started_at timestamptz NOT NULL DEFAULT NOW(),
  ended_at timestamptz,
  CHECK (mode = 'casual' OR bot_rating >= user_rating)  -- the credit-mode rating floor, enforced in SQL
);
CREATE INDEX practice_bot_games_profile_idx ON practice_bot_games (profile_id, started_at DESC);
```

The CHECK constraint at the bottom is the load-bearing enforcement of
the credit-rule. Route code computes the rating differential and sets
`mode`; the constraint refuses to insert a credit-mode row with a
weaker bot. Belt and suspenders.

### Settlement transaction

When a credit-mode game ends with a credit-affecting outcome, the
settlement is one Postgres transaction:

1. `UPDATE practice_bot_games SET result = ..., result_reason = ..., ended_at = NOW(), pgn = ... WHERE id = ...`
2. `INSERT INTO credit_ledger_entries (profile_id, direction, amount, category, reference_type, reference_id) VALUES (..., 'D' or 'C', 1, 'practice_bot_win' or 'practice_bot_loss', 'practice_bot_game', game_id)`

No call to the new `postLedgerTransaction` helper — that's for the
two-sided cash ledger. Credits are single-sided (counterparty is "the
platform"), so a single insert + the surface table update is enough.

---

## UX surface

### Sandbox start screen

```
Practice — full game vs Maia

Time control:  [3+2] [5+0] [10+0] [15+10] [30+0]
Bot rating:    [1500] [1700] [1900]
Your rating:    1623 (chess.com blitz)

Mode:
  ( ) Casual — no credits at stake
  ( ) Credit — win +1 credit, lose −1 credit  ← available only when bot ≥ you
                                                 (currently shown for 1700, 1900)
[ Start game ]
```

When the user picks Maia 1500 (below their 1623 rating), the "Credit"
radio is disabled with a tooltip: "Credit mode requires a bot at or
above your verified rating. Try 1700 or 1900."

### OTB-prep start screen (Phase B)

Same shape, but the bot is "Boris Gelfand (FIDE 2700)" rather than a
ladder. If the opponent's rating < user's rating, credit mode is
disabled with the same tooltip but worded for opponent context.

### Abandonment

A modal at move 5+ telling the user "Disconnecting now will count as a
loss" the first time they try to navigate away mid-game. After that,
behavior is: leave-the-page-mid-game = -1 credit. Server-authoritative
clock + a `last_activity_at` heartbeat keeps the disconnect detection
honest.

---

## Anti-abuse summary

| Vector                                     | Mitigation                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sandbagging via lower-rated bot            | Credit mode gated on bot rating ≥ user rating (CHECK constraint + UI gate)                                                                        |
| Disconnect to avoid a loss                 | After move 5, disconnect = abandoned = −1 credit (server-side heartbeat)                                                                          |
| Spam credit grinding                       | Daily cap on credit-mode games per user (start at 20/day; tune from usage data)                                                                   |
| Rating spoofing on the linked-account      | We only honor ratings from verified `external_accounts` rows; the verification flow already requires posting a token in lichess/chess.com profile |
| Two-account farming                        | Credits earned this way only spend within the same account; cannot transfer to other users                                                        |
| Maia variance gives crooked-feeling losses | Surface "Maia plays human-like; expect natural variance" copy near the credit toggle                                                              |

---

## Phase A scope (now)

Casual sandbox vs the Maia ladder. No credit mode yet; ship the bot UX
first so users can play the bot at all.

## Phase B scope (next, once Phase A is live)

1. Add `practice_bot_games` migration + `practice_bot_win`/`practice_bot_loss` category values to `credit_ledger_entries`.
2. Wire the rating-floor lookup into the sandbox start route.
3. Settlement transaction at game end.
4. Daily cap + abandonment detection.
5. Per-opponent fine-tuned Maia (the OTB-prep wedge).

(1)–(4) can ship before the per-opponent training pipeline is built;
ladder-mode credit games unlock immediately on top of Phase A's
infrastructure.

---

## Open questions

1. Daily cap value — 10 credit-mode games/day? 20? Decide from Phase A casual usage data.
2. Should the user be able to **see the bot's PGN-style history of recent moves** during play, or does that defeat the human-likeness fiction? Default: no, treat Maia as an opaque opponent.
3. Should credit-mode games **affect the user's internal Glicko** at all? Default: no, Maia is too consistent to be a clean rating signal — keep Glicko purely a human-vs-human signal.
4. **Time-control rating coupling** — if user is 1700 blitz but 1400 classical, which is the floor for a classical credit-mode game? Per the time-class table above, we use the matching time class. So a 1400 classical user can credit-grind Maia 1500 in classical only.
5. Onboarding: do new users start with seed credits? Memory note "5 credits on signup" is a common pattern; align with the broader credit-economy doc when that's written.
