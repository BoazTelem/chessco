/**
 * Stage 3 fingerprint matcher — sparse cascade retrieval (v4).
 *
 * Replaces the linear-scan v3 implementation. Now:
 *
 *   Stage A — SQL prefilter on account_fingerprints
 *     · games_window >= minGames
 *     · median_rating BETWEEN target±400 (only when target rating is known)
 *
 *   Stage B — Sparse inverted-index retrieval on fingerprint_terms
 *     · Target features → weighted term list (ECO, move-seq, time)
 *     · SUM(stored.weight × query.weight × kind_weight) per handle
 *     · Top 2,000 by retrieval_score
 *
 *   Stage C — Re-rank with the existing combined-score formula
 *     · Fetch scalar_summary for the top 2,000 from account_fingerprints
 *     · compareFingerprints() blends cosine(eco_w, eco_b, seq_w, seq_b, tc) +
 *       gaussian(opp_rating, cp_loss). Sort, return top-K.
 *
 * Stage D (LLM rerank + verdict + per-candidate prose via DeepSeek) is
 * handled at the web layer in apps/web/lib/scout/evidence-prose.ts.
 *
 * Mirror of apps/web/lib/scout/stage3.ts — both copies must stay in sync.
 *
 * Combined score weights (sum to 1.0):
 *   0.18 × cosine(eco_white)      0.18 × cosine(eco_black)
 *   0.18 × cosine(seq_white)      0.18 × cosine(seq_black)
 *   0.08 × cosine(time_class)
 *   0.10 × gaussianScalar(opp_rating, σ=250)
 *   0.10 × gaussianScalar(mean_cp_loss, σ=20)
 */
import type postgres from 'postgres';
import { extractFingerprintTerms, type FingerprintTerm } from '../features/extract';
import type { PlayerFeaturesV0 } from '../features/types';
import { cosineSparse, gaussianScalar } from './cosine';

export interface Stage3Match {
  player_id: string;
  platform: string;
  handle: string;
  games_window: number;
  combined_score: number;
  /** Sparse retrieval score from Stage B — useful for diagnostics. */
  retrieval_score: number;
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

/** Stage B retrieval weights per kind, mirroring the histogram half of the
 *  combined-score formula. opp_rating and cp_loss aren't terms (they're
 *  scalars handled at Stage A prefilter / Stage C re-rank), so their 0.20
 *  share doesn't apply here. */
const KIND_WEIGHTS: Record<FingerprintTerm['kind'], number> = {
  eco_w: 0.18,
  eco_b: 0.18,
  seq_w: 0.18,
  seq_b: 0.18,
  tc: 0.08,
};

const STAGE_B_CANDIDATE_CAP = 2000;
const RATING_BAND = 400;

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

export async function rankFingerprints(
  sql: postgres.Sql,
  target: PlayerFeaturesV0,
  opts: MatchOptions = {},
): Promise<Stage3Match[]> {
  const topK = opts.topK ?? 10;
  const minGames = opts.minGamesWindow ?? 10;
  const targetTerms = extractFingerprintTerms(target);

  // Empty target → no signal to retrieve against.
  if (targetTerms.length === 0) return [];

  const queryPayload = targetTerms.map((t) => ({
    kind: t.kind,
    term: t.term,
    qweight: t.weight * (KIND_WEIGHTS[t.kind] ?? 0),
  }));
  const queryPayloadJson = JSON.stringify(queryPayload);

  const targetRating =
    target.avg_opponent_rating === null ? null : Math.round(target.avg_opponent_rating);

  // Stage A + B: prefilter and sparse retrieval in a single query. Two
  // branches because postgres-js doesn't compose WHERE fragments cleanly.
  type RetrievalRow = { handle_id: string; retrieval_score: string };
  const ranked = await (targetRating === null
    ? sql<RetrievalRow[]>`
        WITH query_terms AS (
          SELECT (val->>'kind')::text AS kind,
                 (val->>'term')::text AS term,
                 (val->>'qweight')::real AS qweight
          FROM jsonb_array_elements(${queryPayloadJson}::jsonb) AS val
        )
        SELECT af.handle_id::text AS handle_id,
               SUM(ft.weight * qt.qweight)::text AS retrieval_score
        FROM account_fingerprints af
        JOIN fingerprint_terms ft ON ft.handle_id = af.handle_id
        JOIN query_terms qt ON qt.kind = ft.kind AND qt.term = ft.term
        WHERE af.games_window >= ${minGames}
        GROUP BY af.handle_id
        ORDER BY SUM(ft.weight * qt.qweight) DESC
        LIMIT ${STAGE_B_CANDIDATE_CAP}
      `
    : sql<RetrievalRow[]>`
        WITH query_terms AS (
          SELECT (val->>'kind')::text AS kind,
                 (val->>'term')::text AS term,
                 (val->>'qweight')::real AS qweight
          FROM jsonb_array_elements(${queryPayloadJson}::jsonb) AS val
        )
        SELECT af.handle_id::text AS handle_id,
               SUM(ft.weight * qt.qweight)::text AS retrieval_score
        FROM account_fingerprints af
        JOIN fingerprint_terms ft ON ft.handle_id = af.handle_id
        JOIN query_terms qt ON qt.kind = ft.kind AND qt.term = ft.term
        WHERE af.games_window >= ${minGames}
          AND (af.median_rating IS NULL
               OR af.median_rating BETWEEN ${targetRating - RATING_BAND}
                                       AND ${targetRating + RATING_BAND})
        GROUP BY af.handle_id
        ORDER BY SUM(ft.weight * qt.qweight) DESC
        LIMIT ${STAGE_B_CANDIDATE_CAP}
      `);

  if (ranked.length === 0) return [];

  // Stage C: hydrate scalar_summary for the top 2k, run combined-score
  // re-rank, return top-K.
  const handleIds = ranked.map((r) => r.handle_id);
  type HydratedRow = {
    handle_id: string;
    platform: string;
    handle: string;
    games_window: number;
    scalar_summary: PlayerFeaturesV0 | string;
  };
  const hydrated = await sql<HydratedRow[]>`
    SELECT af.handle_id::text AS handle_id,
           af.platform,
           af.handle,
           af.games_window,
           af.scalar_summary
    FROM account_fingerprints af
    WHERE af.handle_id = ANY(${handleIds}::uuid[])
  `;
  const hydratedById = new Map(hydrated.map((h) => [h.handle_id, h]));
  const retrievalById = new Map(ranked.map((r) => [r.handle_id, Number(r.retrieval_score)]));

  const scored: Stage3Match[] = [];
  for (const id of handleIds) {
    const h = hydratedById.get(id);
    if (!h) continue;
    const cand: PlayerFeaturesV0 =
      typeof h.scalar_summary === 'string' ? JSON.parse(h.scalar_summary) : h.scalar_summary;
    const { combined, components } = compareFingerprints(target, cand);
    scored.push({
      player_id: id,
      platform: h.platform,
      handle: h.handle,
      games_window: h.games_window,
      combined_score: combined,
      retrieval_score: retrievalById.get(id) ?? 0,
      components,
    });
  }

  scored.sort((a, b) => b.combined_score - a.combined_score);
  return scored.slice(0, topK);
}
