/**
 * V0 player feature schema — what we can compute from the games table
 * without engine evaluation. Stockfish-derived features (cp-loss curve,
 * blunder rate, etc.) come in W4.5; transformer embeddings in Phase 2.
 *
 * Stored as `style_features.features` jsonb. Each handle (uuid in the
 * games-corpus `handles` table) gets exactly one row.
 *
 * Distributions are stored as raw COUNTS (not normalized), so we can
 * meaningfully combine them across handles when needed and reapply
 * proper cosine similarity downstream (W5).
 */
export interface PlayerFeaturesV0 {
  version: 'v0';

  // ---- coverage ----
  games_total: number;
  games_as_white: number;
  games_as_black: number;

  // ---- result mix (per color) ----
  wins_as_white: number;
  losses_as_white: number;
  draws_as_white: number;
  wins_as_black: number;
  losses_as_black: number;
  draws_as_black: number;

  // ---- opening repertoire (ECO codes, top-K by frequency) ----
  /** ECO code → games played as that color. e.g. {"B30": 12, "C57": 8}. */
  eco_white: Record<string, number>;
  eco_black: Record<string, number>;

  // ---- time-control preference ----
  /** time_class → games at that pace. {"bullet": 30, "blitz": 50, "rapid": 7}. */
  time_class: Record<string, number>;

  // ---- termination patterns ----
  /** termination tag → games ending that way. Lichess: "Normal" / "Time forfeit" / "Abandoned" / etc. */
  termination: Record<string, number>;

  // ---- aggregate numerics ----
  avg_ply_count: number;
  /** Average rating of opponents — proxy for the player's own skill band. */
  avg_opponent_rating: number | null;
  /** Min/max opponent rating observed (sanity-check + range signal). */
  opponent_rating_min: number | null;
  opponent_rating_max: number | null;

  // ---- timing summary ----
  /** Window covered by these games. */
  earliest_played_at: string;
  latest_played_at: string;
}
