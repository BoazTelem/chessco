/**
 * Pure function: a player's games → PlayerFeaturesV0.
 *
 * Caller provides the rows already filtered to one player (one (platform,
 * handle) tuple), with a `color` discriminator per row. extract() is
 * deterministic and side-effect-free for easy unit testing.
 */
import type { PlayerFeaturesV0 } from './types';

export interface GameRow {
  color: 'white' | 'black';
  result: '1-0' | '0-1' | '1/2-1/2';
  time_class: string | null;
  opening_eco: string | null;
  ply_count: number;
  termination: string | null;
  opponent_rating: number | null;
  played_at: Date;
  // ---- Optional Stockfish-derived per-game aggregates (Phase 1 W5) ----
  // Pre-computed by apps/workers/src/stockfish/backfill.ts and stored on
  // the `games` row. Present for analyzed games, null for the rest.
  mean_cp_loss?: number | null;
  mean_cp_loss_white?: number | null;
  mean_cp_loss_black?: number | null;
  blunder_count?: number | null;
  plies_analyzed?: number | null;
}

export function extractFeaturesV0(games: GameRow[]): PlayerFeaturesV0 {
  const total = games.length;
  let asW = 0;
  let asB = 0;
  let winW = 0;
  let lossW = 0;
  let drawW = 0;
  let winB = 0;
  let lossB = 0;
  let drawB = 0;
  const ecoW: Record<string, number> = {};
  const ecoB: Record<string, number> = {};
  const timeClass: Record<string, number> = {};
  const termination: Record<string, number> = {};
  let plySum = 0;
  let oppRatingSum = 0;
  let oppRatingCount = 0;
  let oppMin: number | null = null;
  let oppMax: number | null = null;
  let earliest: Date | null = null;
  let latest: Date | null = null;

  // cp-loss aggregation across analyzed games only. Weighted by plies_analyzed
  // so a 60-ply analyzed game contributes more than a 12-ply one.
  let analyzedGames = 0;
  let cpLossPlyTotal = 0;
  let cpLossWeightedSum = 0;
  let cpLossWhitePlyTotal = 0;
  let cpLossWhiteWeightedSum = 0;
  let cpLossBlackPlyTotal = 0;
  let cpLossBlackWeightedSum = 0;
  let blunderCount = 0;

  for (const g of games) {
    if (g.color === 'white') {
      asW++;
      if (g.result === '1-0') winW++;
      else if (g.result === '0-1') lossW++;
      else drawW++;
      if (g.opening_eco) ecoW[g.opening_eco] = (ecoW[g.opening_eco] ?? 0) + 1;
    } else {
      asB++;
      if (g.result === '0-1') winB++;
      else if (g.result === '1-0') lossB++;
      else drawB++;
      if (g.opening_eco) ecoB[g.opening_eco] = (ecoB[g.opening_eco] ?? 0) + 1;
    }

    if (g.time_class) timeClass[g.time_class] = (timeClass[g.time_class] ?? 0) + 1;
    if (g.termination) {
      // Lichess sends Title-Case strings ("Normal", "Time forfeit"); lowercase for stability.
      const t = g.termination.toLowerCase();
      termination[t] = (termination[t] ?? 0) + 1;
    }

    plySum += g.ply_count;

    if (g.opponent_rating != null) {
      oppRatingSum += g.opponent_rating;
      oppRatingCount++;
      if (oppMin === null || g.opponent_rating < oppMin) oppMin = g.opponent_rating;
      if (oppMax === null || g.opponent_rating > oppMax) oppMax = g.opponent_rating;
    }

    if (earliest === null || g.played_at < earliest) earliest = g.played_at;
    if (latest === null || g.played_at > latest) latest = g.played_at;

    // Aggregate cp-loss only when the game has been analyzed (plies_analyzed
    // is the unambiguous signal). The mover-color split lets the matcher
    // pick out "this player blunders as black" patterns later.
    if (g.plies_analyzed != null && g.plies_analyzed > 0) {
      analyzedGames++;
      if (g.mean_cp_loss != null) {
        cpLossPlyTotal += g.plies_analyzed;
        cpLossWeightedSum += g.mean_cp_loss * g.plies_analyzed;
      }
      // The per-side numbers cover only the analyzed plies of that color.
      // We don't track per-color ply count separately, so weight by half
      // the total analyzed plies as an approximation — close enough for
      // averaging across many games.
      const halfPlies = g.plies_analyzed / 2;
      if (g.mean_cp_loss_white != null) {
        cpLossWhitePlyTotal += halfPlies;
        cpLossWhiteWeightedSum += g.mean_cp_loss_white * halfPlies;
      }
      if (g.mean_cp_loss_black != null) {
        cpLossBlackPlyTotal += halfPlies;
        cpLossBlackWeightedSum += g.mean_cp_loss_black * halfPlies;
      }
      if (g.blunder_count != null) blunderCount += g.blunder_count;
    }
  }

  return {
    version: 'v0',
    games_total: total,
    games_as_white: asW,
    games_as_black: asB,
    wins_as_white: winW,
    losses_as_white: lossW,
    draws_as_white: drawW,
    wins_as_black: winB,
    losses_as_black: lossB,
    draws_as_black: drawB,
    eco_white: ecoW,
    eco_black: ecoB,
    time_class: timeClass,
    termination,
    avg_ply_count: total > 0 ? plySum / total : 0,
    avg_opponent_rating: oppRatingCount > 0 ? oppRatingSum / oppRatingCount : null,
    opponent_rating_min: oppMin,
    opponent_rating_max: oppMax,
    earliest_played_at: earliest?.toISOString() ?? new Date(0).toISOString(),
    latest_played_at: latest?.toISOString() ?? new Date(0).toISOString(),
    analyzed_games: analyzedGames,
    mean_cp_loss: cpLossPlyTotal > 0 ? cpLossWeightedSum / cpLossPlyTotal : null,
    mean_cp_loss_white:
      cpLossWhitePlyTotal > 0 ? cpLossWhiteWeightedSum / cpLossWhitePlyTotal : null,
    mean_cp_loss_black:
      cpLossBlackPlyTotal > 0 ? cpLossBlackWeightedSum / cpLossBlackPlyTotal : null,
    blunder_rate: cpLossPlyTotal > 0 ? blunderCount / cpLossPlyTotal : null,
  };
}
