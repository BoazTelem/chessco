/**
 * Stage 3 — fingerprint matcher.
 *
 * Input:  target PlayerFeaturesV0 (extracted from pasted PGN(s))
 * Lookup: all style_features rows in chessco-games
 * Output: top-K candidates ranked by combined similarity score
 *
 * Combined score (weights sum to 1.0):
 *   0.30 × cosine(eco_white)              — repertoire as White
 *   0.30 × cosine(eco_black)              — repertoire as Black
 *   0.10 × cosine(time_class)             — pace preference
 *   0.15 × gaussianScalar(opp_rating, σ=250)
 *   0.15 × gaussianScalar(mean_cp_loss, σ=20)   — play quality (Stockfish)
 *
 * The cp-loss term contributes 0 when either side hasn't been analyzed yet,
 * so the matcher degrades gracefully during a rolling backfill — handles
 * with engine evals just get a real signal there; unanalyzed handles get 0.
 */
import type postgres from 'postgres';
import type { PlayerFeaturesV0 } from '../features/types';
import { cosineSparse, gaussianScalar } from './cosine';

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
    cp_loss: number;
  };
}

export interface MatchOptions {
  topK?: number;
  /** Drop candidates whose games_window < this. Default 10. */
  minGamesWindow?: number;
}

export function compareFingerprints(
  target: PlayerFeaturesV0,
  cand: PlayerFeaturesV0,
): { combined: number; components: Stage3Match['components'] } {
  const ecoW = cosineSparse(target.eco_white, cand.eco_white);
  const ecoB = cosineSparse(target.eco_black, cand.eco_black);
  const time = cosineSparse(target.time_class, cand.time_class);
  const opp = gaussianScalar(target.avg_opponent_rating, cand.avg_opponent_rating, 250);
  // gaussianScalar returns 0 when either input is null, so partially-analyzed
  // corpora gracefully degrade to "no cp-loss signal" without code branches.
  const cpLoss = gaussianScalar(target.mean_cp_loss ?? null, cand.mean_cp_loss ?? null, 20);

  const combined = 0.3 * ecoW + 0.3 * ecoB + 0.1 * time + 0.15 * opp + 0.15 * cpLoss;

  return {
    combined,
    components: {
      eco_white: ecoW,
      eco_black: ecoB,
      time_class: time,
      opp_rating: opp,
      cp_loss: cpLoss,
    },
  };
}

interface StyleFeaturesRow {
  player_id: string;
  features: PlayerFeaturesV0 | string;
  games_window: number;
  platform: string;
  handle: string;
}

export async function rankFingerprints(
  sql: postgres.Sql,
  target: PlayerFeaturesV0,
  opts: MatchOptions = {},
): Promise<Stage3Match[]> {
  const topK = opts.topK ?? 10;
  const minGames = opts.minGamesWindow ?? 10;

  const rows = await sql<StyleFeaturesRow[]>`
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
  return scored.slice(0, topK);
}
