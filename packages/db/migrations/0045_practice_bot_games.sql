-- Practice-bot game tracking — Phase 6A/6C scaffolding.
-- Design rationale: docs/PRACTICE-CREDIT-MODE.md
-- HTTP contract: docs/MAIA-INFERENCE.md
-- Inference service: services/maia-inference/

CREATE TABLE IF NOT EXISTS practice_bot_games (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  -- Where this game came from. 'sandbox' = generic Maia ladder pick;
  -- 'otb' = per-opponent fine-tuned Maia (Phase 6B).
  surface text NOT NULL CHECK (surface IN ('sandbox', 'otb')),

  -- 'ladder' = bot_rating is one of the seeded ladder buckets;
  -- 'opponent_individual' = bot_rating is the opponent's verified rating
  -- and weights_id points at a Maia fine-tune of that opponent.
  bot_kind text NOT NULL CHECK (bot_kind IN ('ladder', 'opponent_individual')),

  -- Snapshotted at game start. user_rating is the caller's verified rating
  -- in the chosen time_class at the moment they hit /start; bot_rating is
  -- the ladder bucket or opponent rating they chose.
  bot_rating integer NOT NULL,
  user_rating integer NOT NULL,

  weights_id uuid NOT NULL REFERENCES maia_weights(id),

  time_class text NOT NULL CHECK (time_class IN ('bullet', 'blitz', 'rapid', 'classical')),
  time_control text NOT NULL,             -- e.g. '5+0', '15+10'

  mode text NOT NULL CHECK (mode IN ('casual', 'credit')),

  result text CHECK (result IN ('user_win', 'user_loss', 'draw', 'abandoned')),
  result_reason text,                     -- 'checkmate', 'resign', 'timeout', 'stalemate', '50_move', 'threefold', 'insufficient_material', 'disconnect'

  pgn text,                               -- full game PGN, set at /end

  started_at timestamptz NOT NULL DEFAULT NOW(),
  ended_at timestamptz,

  -- Load-bearing: SQL-side enforcement of the credit-mode rating-floor rule
  -- so a route bug can NEVER insert a credit-mode row with a weaker bot.
  -- See docs/PRACTICE-CREDIT-MODE.md.
  CONSTRAINT practice_bot_games_credit_floor_check
    CHECK (mode = 'casual' OR bot_rating >= user_rating)
);

CREATE INDEX IF NOT EXISTS practice_bot_games_profile_idx
  ON practice_bot_games (profile_id, started_at DESC);
CREATE INDEX IF NOT EXISTS practice_bot_games_weights_idx
  ON practice_bot_games (weights_id);

-- RLS: the route layer is the only entry path today; the practice DB is
-- queried via service role. Enable RLS without policies so any future
-- client-side query against this table fails closed instead of leaking
-- one user's game history to another.
ALTER TABLE practice_bot_games ENABLE ROW LEVEL SECURITY;
