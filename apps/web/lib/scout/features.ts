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
  time_class: Record<string, number>;
  termination: Record<string, number>;
  avg_ply_count: number;
  avg_opponent_rating: number | null;
  opponent_rating_min: number | null;
  opponent_rating_max: number | null;
  earliest_played_at: string;
  latest_played_at: string;
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
  };
}
