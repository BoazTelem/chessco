/**
 * Web-side Stage 3 matcher.
 *
 * Mirror of apps/workers/src/stage3/match.ts — duplicated rather than
 * cross-app imported, but kept logically identical. When the algorithm
 * evolves both copies should change together (W4.5 Stockfish features
 * will hit both files).
 */
import { getGamesDb } from '@/lib/games-db';
import { extractFeaturesV0, type GameRow, type PlayerFeaturesV0 } from './features';

export interface Stage3Match {
  player_id: string;
  platform: string;
  handle: string;
  games_window: number;
  combined_score: number;
  components: {
    eco_white: number;
    eco_black: number;
    time_class: number;
    opp_rating: number;
  };
}

function cosineSparse(a: Record<string, number>, b: Record<string, number>): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const k in a) {
    const av = a[k] ?? 0;
    magA += av * av;
    const bv = b[k];
    if (bv !== undefined) dot += av * bv;
  }
  for (const k in b) {
    const bv = b[k] ?? 0;
    magB += bv * bv;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function gaussianScalar(a: number | null, b: number | null, sigma = 250): number {
  if (a === null || b === null) return 0;
  const diff = a - b;
  return Math.exp(-(diff * diff) / (2 * sigma * sigma));
}

export function compareFingerprints(
  target: PlayerFeaturesV0,
  cand: PlayerFeaturesV0,
): { combined: number; components: Stage3Match['components'] } {
  const ecoW = cosineSparse(target.eco_white, cand.eco_white);
  const ecoB = cosineSparse(target.eco_black, cand.eco_black);
  const time = cosineSparse(target.time_class, cand.time_class);
  const opp = gaussianScalar(target.avg_opponent_rating, cand.avg_opponent_rating, 250);
  const combined = 0.4 * ecoW + 0.4 * ecoB + 0.1 * time + 0.1 * opp;
  return {
    combined,
    components: { eco_white: ecoW, eco_black: ecoB, time_class: time, opp_rating: opp },
  };
}

export async function rankBySampleGames(
  games: GameRow[],
  opts: { topK?: number; minGamesWindow?: number } = {},
): Promise<{ target: PlayerFeaturesV0; matches: Stage3Match[] }> {
  const topK = opts.topK ?? 15;
  const minGames = opts.minGamesWindow ?? 10;
  const target = extractFeaturesV0(games);

  const sql = getGamesDb();
  type Row = {
    player_id: string;
    features: PlayerFeaturesV0 | string;
    games_window: number;
    platform: string;
    handle: string;
  };
  const rows = await sql<Row[]>`
    SELECT sf.player_id, sf.features, sf.games_window, h.platform, h.handle
    FROM style_features sf
    JOIN handles h ON h.id = sf.player_id
    WHERE sf.games_window >= ${minGames}
  `;

  const scored: Stage3Match[] = [];
  for (const r of rows) {
    const cand: PlayerFeaturesV0 =
      typeof r.features === 'string' ? JSON.parse(r.features) : r.features;
    const { combined, components } = compareFingerprints(target, cand);
    scored.push({
      player_id: r.player_id,
      platform: r.platform,
      handle: r.handle,
      games_window: r.games_window,
      combined_score: combined,
      components,
    });
  }
  scored.sort((a, b) => b.combined_score - a.combined_score);
  return { target, matches: scored.slice(0, topK) };
}
