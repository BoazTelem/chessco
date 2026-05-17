/**
 * Web-side Stage 3 matcher — sparse cascade retrieval (v4).
 *
 * Pipeline (per PGN-upload query):
 *
 *   Stage A — SQL prefilter on account_fingerprints
 *     · games_window >= minGames (always)
 *     · median_rating BETWEEN target±400 (only when target has rating data)
 *
 *   Stage B — Sparse inverted-index retrieval on fingerprint_terms
 *     · Project target features → weighted term list (ECO, move-seq, time)
 *     · Apply kind weights mirroring the combined-score formula
 *     · SUM(stored.weight × query.weight × kind_weight) per handle
 *     · Top 2,000 by retrieval_score
 *
 *   Stage C — Re-rank with the existing combined-score formula
 *     · Fetch scalar_summary for the top 2,000 (jsonb_summary already has V0)
 *     · compareFingerprints() weighs cosine(eco_w, eco_b, seq_w, seq_b, tc) +
 *       gaussian(opp_rating, cp_loss). Sort by combined_score, return top-K.
 *
 * Stage D (LLM rerank + verdict + per-candidate prose via DeepSeek) is
 * handled by `generateRerankProse` in evidence-prose.ts — already wired,
 * fail-soft, env-gated on DEEPSEEK_API_KEY.
 *
 * Mirror of apps/workers/src/stage3/match.ts — both copies must stay in
 * sync. The sparse cascade replaced the linear-scan v3 matcher when the
 * sparse fingerprint storage landed (migration 0010_account_fingerprints).
 */
import { getGamesDb } from '@/lib/games-db';
import {
  extractFeaturesV0,
  extractFingerprintTerms,
  type FingerprintTerm,
  type GameRow,
  type PlayerFeaturesV0,
} from './features';

export interface Stage3Match {
  player_id: string;
  platform: string;
  handle: string;
  games_window: number;
  combined_score: number;
  /** Sparse-retrieval score from Stage B — useful for diagnostics. */
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

/** Re-rank kind weights for Stage B sparse retrieval. Mirrors the histogram
 *  half of the combined-score formula so retrieval ordering pre-shapes the
 *  candidate pool toward what Stage C will eventually pick. opp_rating and
 *  cp_loss aren't terms (they're scalars), so their 0.20 of total weight is
 *  applied only at Stage C. */
const KIND_WEIGHTS: Record<FingerprintTerm['kind'], number> = {
  eco_w: 0.18,
  eco_b: 0.18,
  seq_w: 0.18,
  seq_b: 0.18,
  tc: 0.08,
};

const STAGE_B_CANDIDATE_CAP = 2000;
const RATING_BAND = 400;

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

export type MatchCohort = 'standard' | 'few_games';

/** At/below this sample-game count we lean on the few-games weight profile. */
export const FEW_GAMES_THRESHOLD = 8;

export function cohortFromSampleSize(n: number): MatchCohort {
  return n <= FEW_GAMES_THRESHOLD ? 'few_games' : 'standard';
}

const COHORT_WEIGHTS: Record<
  MatchCohort,
  {
    ecoW: number;
    ecoB: number;
    seqW: number;
    seqB: number;
    time: number;
    opp: number;
    cpLoss: number;
  }
> = {
  // Few-games tilt: at small N, opp_rating + cp_loss are too noisy to be
  // useful, so we reweight onto the opening fingerprint. See
  // apps/workers/src/stage3/match.ts for the rationale.
  standard: { ecoW: 0.18, ecoB: 0.18, seqW: 0.18, seqB: 0.18, time: 0.08, opp: 0.1, cpLoss: 0.1 },
  few_games: { ecoW: 0.24, ecoB: 0.24, seqW: 0.24, seqB: 0.24, time: 0.04, opp: 0.0, cpLoss: 0.0 },
};

export function compareFingerprints(
  target: PlayerFeaturesV0,
  cand: PlayerFeaturesV0,
  cohort: MatchCohort = 'standard',
): { combined: number; components: Stage3Match['components'] } {
  const ecoW = cosineSparse(target.eco_white, cand.eco_white);
  const ecoB = cosineSparse(target.eco_black, cand.eco_black);
  const seqW = cosineSparse(target.move_seq_white ?? {}, cand.move_seq_white ?? {});
  const seqB = cosineSparse(target.move_seq_black ?? {}, cand.move_seq_black ?? {});
  const time = cosineSparse(target.time_class, cand.time_class);
  const opp = gaussianScalar(target.avg_opponent_rating, cand.avg_opponent_rating, 250);
  const cpLoss = gaussianScalar(target.mean_cp_loss ?? null, cand.mean_cp_loss ?? null, 20);
  const w = COHORT_WEIGHTS[cohort];
  const combined =
    w.ecoW * ecoW +
    w.ecoB * ecoB +
    w.seqW * seqW +
    w.seqB * seqB +
    w.time * time +
    w.opp * opp +
    w.cpLoss * cpLoss;
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

export async function rankBySampleGames(
  games: GameRow[],
  opts: { topK?: number; minGamesWindow?: number; cohort?: MatchCohort } = {},
): Promise<{ target: PlayerFeaturesV0; matches: Stage3Match[] }> {
  const topK = opts.topK ?? 15;
  const minGames = opts.minGamesWindow ?? 10;
  const target = extractFeaturesV0(games);
  // Default cohort comes from games.length, not target.games_total — at the
  // entrypoint the two are equal, but explicit input count is the API
  // contract callers reason about.
  const cohort: MatchCohort = opts.cohort ?? cohortFromSampleSize(games.length);
  const targetTerms = extractFingerprintTerms(target);

  // Empty target → no signal to retrieve against. Bail cleanly so the
  // caller can fall back to bullet reasons or "insufficient evidence".
  if (targetTerms.length === 0) {
    return { target, matches: [] };
  }

  const sql = getGamesDb();

  // ---- Build the query-terms JSONB payload ---------------------------
  // Each query term carries its pre-multiplied weight (term_freq × kind_weight)
  // so Stage B's SUM is a pure dot product on the Postgres side.
  const queryPayload = targetTerms.map((t) => ({
    kind: t.kind,
    term: t.term,
    qweight: t.weight * (KIND_WEIGHTS[t.kind] ?? 0),
  }));
  const queryPayloadJson = JSON.stringify(queryPayload);

  // ---- Stage A + B: prefilter and sparse retrieval in one query ------
  // We split the rating filter into "applied" vs "skipped" branches because
  // postgres-js doesn't compose `WHERE` fragments cleanly; the duplication is
  // worth the simplicity. median_rating IS NULL is kept inclusive so handles
  // whose own rating signal hasn't been computed yet still surface.
  const targetRating =
    target.avg_opponent_rating === null ? null : Math.round(target.avg_opponent_rating);

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

  if (ranked.length === 0) {
    return { target, matches: [] };
  }

  // ---- Stage C: hydrate scalar_summary for the top 2k and re-rank ----
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
    const { combined, components } = compareFingerprints(target, cand, cohort);
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
  return { target, matches: scored.slice(0, topK) };
}
