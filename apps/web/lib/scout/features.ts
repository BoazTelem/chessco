/**
 * V0 player feature extraction — mirror of apps/workers/src/features/
 * extract.ts. Pure function: parsed game rows in, jsonb fingerprint out.
 *
 * The two copies must stay in sync. When the algorithm evolves (W4.5
 * Stockfish features), both files change together.
 */
export interface PlayerFeaturesV0 {
  version: 'v0';
  games_total: number;
  games_as_white: number;
  games_as_black: number;
  wins_as_white: number;
  losses_as_white: number;
  draws_as_white: number;
  wins_as_black: number;
  losses_as_black: number;
  draws_as_black: number;
  eco_white: Record<string, number>;
  eco_black: Record<string, number>;
  /** First 12 plies SAN, frequency-counted per color. Phase 1 W5 v3 —
   *  sharper than ECO bucket overlap. See workers/src/features/types.ts. */
  move_seq_white?: Record<string, number>;
  move_seq_black?: Record<string, number>;
  time_class: Record<string, number>;
  termination: Record<string, number>;
  avg_ply_count: number;
  avg_opponent_rating: number | null;
  opponent_rating_min: number | null;
  opponent_rating_max: number | null;
  earliest_played_at: string;
  latest_played_at: string;
  // Stockfish-derived stylometric signals (Phase 1 W5). See the worker
  // copy at apps/workers/src/features/types.ts for full design notes.
  analyzed_games?: number;
  mean_cp_loss?: number | null;
  mean_cp_loss_white?: number | null;
  mean_cp_loss_black?: number | null;
  blunder_rate?: number | null;
}

export interface GameRow {
  color: 'white' | 'black';
  result: '1-0' | '0-1' | '1/2-1/2';
  time_class: string | null;
  opening_eco: string | null;
  ply_count: number;
  termination: string | null;
  opponent_rating: number | null;
  played_at: Date;
  mean_cp_loss?: number | null;
  mean_cp_loss_white?: number | null;
  mean_cp_loss_black?: number | null;
  blunder_count?: number | null;
  plies_analyzed?: number | null;
  /** First 12 SAN plies, joined by single space (Phase 1 W5 v3). */
  move_seq_prefix?: string;
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
  const seqW: Record<string, number> = {};
  const seqB: Record<string, number> = {};
  const timeClass: Record<string, number> = {};
  const termination: Record<string, number> = {};
  let plySum = 0;
  let oppRatingSum = 0;
  let oppRatingCount = 0;
  let oppMin: number | null = null;
  let oppMax: number | null = null;
  let earliest: Date | null = null;
  let latest: Date | null = null;
  let analyzedGames = 0;
  let cpLossPlyTotal = 0;
  let cpLossWeightedSum = 0;
  let cpLossWhitePlyTotal = 0;
  let cpLossWhiteWeightedSum = 0;
  let cpLossBlackPlyTotal = 0;
  let cpLossBlackWeightedSum = 0;
  let blunderCount = 0;

  for (const g of games) {
    const seq = g.move_seq_prefix && g.move_seq_prefix.length > 0 ? g.move_seq_prefix : null;
    if (g.color === 'white') {
      asW++;
      if (g.result === '1-0') winW++;
      else if (g.result === '0-1') lossW++;
      else drawW++;
      if (g.opening_eco) ecoW[g.opening_eco] = (ecoW[g.opening_eco] ?? 0) + 1;
      if (seq) seqW[seq] = (seqW[seq] ?? 0) + 1;
    } else {
      asB++;
      if (g.result === '0-1') winB++;
      else if (g.result === '1-0') lossB++;
      else drawB++;
      if (g.opening_eco) ecoB[g.opening_eco] = (ecoB[g.opening_eco] ?? 0) + 1;
      if (seq) seqB[seq] = (seqB[seq] ?? 0) + 1;
    }
    if (g.time_class) timeClass[g.time_class] = (timeClass[g.time_class] ?? 0) + 1;
    if (g.termination) {
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

    if (g.plies_analyzed != null && g.plies_analyzed > 0) {
      analyzedGames++;
      if (g.mean_cp_loss != null) {
        cpLossPlyTotal += g.plies_analyzed;
        cpLossWeightedSum += g.mean_cp_loss * g.plies_analyzed;
      }
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
    move_seq_white: seqW,
    move_seq_black: seqB,
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
