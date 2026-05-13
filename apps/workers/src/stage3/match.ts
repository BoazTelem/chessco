/**
 * Stage 3 — fingerprint matcher (v3: opening-sequence + cp-loss).
 *
 * Input:  target PlayerFeaturesV0 (extracted from pasted PGN(s))
 * Lookup: all style_features rows in chessco-games
 * Output: top-K candidates ranked by combined similarity score
 *
 * Combined score (weights sum to 1.0):
 *   0.18 × cosine(eco_white)              — repertoire ECO as White
 *   0.18 × cosine(eco_black)              — repertoire ECO as Black
 *   0.18 × cosine(move_seq_white)         — exact first-12-plies as White
 *   0.18 × cosine(move_seq_black)         — exact first-12-plies as Black
 *   0.08 × cosine(time_class)             — pace preference
 *   0.10 × gaussianScalar(opp_rating, σ=250)
 *   0.10 × gaussianScalar(mean_cp_loss, σ=20)   — play quality (Stockfish)
 *
 * ECO weight was reduced from 0.30→0.18 each because the move-sequence
 * histogram subsumes ECO bucket overlap when the sequences match; ECO
 * still provides complementary signal for cross-line transpositions.
 *
 * Both new terms (move_seq + cp_loss) return 0 when either side lacks the
 * data, so the matcher degrades gracefully during rolling backfills.
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
    move_seq_white: number;
    move_seq_black: number;
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
  // move_seq histograms are optional on the feature struct (older
  // style_features rows pre-v3 don't have them). Empty maps yield 0
  // similarity in cosineSparse, which is the correct "no signal" answer.
  const seqW = cosineSparse(target.move_seq_white ?? {}, cand.move_seq_white ?? {});
  const seqB = cosineSparse(target.move_seq_black ?? {}, cand.move_seq_black ?? {});
  const time = cosineSparse(target.time_class, cand.time_class);
  const opp = gaussianScalar(target.avg_opponent_rating, cand.avg_opponent_rating, 250);
  const cpLoss = gaussianScalar(target.mean_cp_loss ?? null, cand.mean_cp_loss ?? null, 20);

  const combined =
    0.18 * ecoW + 0.18 * ecoB + 0.18 * seqW + 0.18 * seqB + 0.08 * time + 0.1 * opp + 0.1 * cpLoss;

  return {
    combined,
    components: {
      eco_white: ecoW,
      eco_black: ecoB,
      move_seq_white: seqW,
      move_seq_black: seqB,
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
