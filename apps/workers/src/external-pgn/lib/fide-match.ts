/**
 * FIDE-name resolver for external_pgn_sources rows.
 *
 * Takes a name as it appears in a PGN [White] / [Black] header (TWIC,
 * chessgames.com, …) and an optional Elo, and resolves to a
 * federation_players.id via pg_trgm similarity gated by Elo proximity.
 *
 * Why this is hard: external PGN names are abbreviated (TWIC writes
 * "Carlsen,M" for elite events while FIDE stores "Carlsen, Magnus"; pg_trgm
 * similarity drops to ~0.4 for this kind of pair). We use the Elo signal
 * to disambiguate when names alone are ambiguous — TWIC's WhiteElo is the
 * player's FIDE rating snapshot for the event, so it should be within a
 * narrow band of federation_players.rating_standard.
 *
 * Trigger sites:
 *   - apps/workers/src/external-pgn/resolve.ts — the worker that sweeps
 *     external_pgn_sources rows.
 *   - Future per-source pipelines that want to inline-resolve as they
 *     ingest (e.g. for /scout result enrichment).
 */
import type postgres from 'postgres';
import { normalizeName } from '../../fide/normalize';

/**
 * TWIC and similar sources collapse the FIDE comma-separated "Last, First"
 * style to "Last,First" (no space). normalizeName strips commas, which
 * would glue the tokens together ("carlsenm" instead of "carlsen m"). We
 * pre-insert a space so the tokeniser sees the right shape.
 *
 * Also strips trailing federation tags some sources append ("Grigoriants,S
 * RUS" → "Grigoriants, S").
 */
export function normalizeExternalName(raw: string): string {
  if (!raw) return '';
  // Ensure comma is a separator before normalizeName strips it.
  let cleaned = raw.replace(/,/g, ', ');
  // Trailing 3-letter country code that TWIC sometimes appends.
  cleaned = cleaned.replace(/\s+[A-Z]{3}\b\s*$/, '');
  return normalizeName(cleaned);
}

export interface FideMatch {
  id: string;
  name: string;
  rating_standard: number | null;
  sim: number;
}

interface CandidateRow {
  id: string;
  name: string;
  rating_standard: number | null;
  sim: number;
}

export interface ResolverConfig {
  /** Minimum trigram similarity to even consider a candidate. */
  minSimilarity: number;
  /** Maximum Elo gap when both sides have ratings. */
  maxEloGap: number;
  /**
   * When two candidates tie within this similarity delta, defer to whichever
   * has a closer Elo. Below this delta the ranking is similarity-first.
   */
  similarityTieThreshold: number;
  /** Trigram weight in the combined score. (1 - this) is the Elo weight. */
  similarityWeight: number;
  /** Elo gap that drops the Elo component to zero (linear decay). */
  eloDecayWindow: number;
}

export const DEFAULT_RESOLVER_CONFIG: ResolverConfig = {
  minSimilarity: 0.3,
  maxEloGap: 250,
  similarityTieThreshold: 0.1,
  similarityWeight: 0.5,
  eloDecayWindow: 300,
};

function combinedScore(c: CandidateRow, elo: number | null, cfg: ResolverConfig): number {
  if (elo === null || c.rating_standard === null) return c.sim;
  const gap = Math.abs(c.rating_standard - elo);
  const eloComponent = Math.max(0, 1 - gap / cfg.eloDecayWindow);
  return cfg.similarityWeight * c.sim + (1 - cfg.similarityWeight) * eloComponent;
}

/**
 * Resolve a single external name → federation_players row, or null.
 *
 * Cross-DB note: this hits Supabase (federation_players lives there); the
 * external_pgn_sources row that triggered the call lives in the games-
 * corpus DB. The resolver worker handles the two-DB coordination.
 */
export async function resolveFideName(
  supaSql: postgres.Sql,
  name: string,
  elo: number | null,
  cfg: ResolverConfig = DEFAULT_RESOLVER_CONFIG,
): Promise<FideMatch | null> {
  const normalized = normalizeExternalName(name);
  if (normalized.length < 3) return null;

  // Pre-filter by Elo when available so we don't pay for the trigram search
  // over the long tail of FIDE rows.
  const candidates =
    elo !== null
      ? await supaSql<CandidateRow[]>`
        SELECT id::text, name, rating_standard,
               similarity(name_normalized, ${normalized}) AS sim
        FROM federation_players
        WHERE name_normalized % ${normalized}
          AND rating_standard BETWEEN ${elo - cfg.maxEloGap} AND ${elo + cfg.maxEloGap}
        ORDER BY sim DESC
        LIMIT 10
      `
      : await supaSql<CandidateRow[]>`
        SELECT id::text, name, rating_standard,
               similarity(name_normalized, ${normalized}) AS sim
        FROM federation_players
        WHERE name_normalized % ${normalized}
        ORDER BY sim DESC
        LIMIT 10
      `;

  if (candidates.length === 0) return null;
  if (candidates[0]!.sim < cfg.minSimilarity) return null;

  // If Elo is available, re-rank top candidates by combined score —
  // similarity + Elo proximity. This swaps "Carlsen,Mikael" (slightly
  // closer name match) for "Carlsen, Magnus" (Elo-correct) when the
  // TWIC row says 2830.
  let best = candidates[0]!;
  if (elo !== null && candidates.length > 1) {
    let bestScore = combinedScore(best, elo, cfg);
    for (let i = 1; i < candidates.length; i++) {
      const c = candidates[i]!;
      const score = combinedScore(c, elo, cfg);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
  }

  // Final Elo-gap sanity (when both sides have a rating). The pre-filter
  // already enforced this when running with Elo, but be explicit for the
  // null-Elo path too.
  if (elo !== null && best.rating_standard !== null) {
    if (Math.abs(best.rating_standard - elo) > cfg.maxEloGap) return null;
  }

  return best;
}
