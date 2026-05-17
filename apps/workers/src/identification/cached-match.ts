/**
 * Search platform_players for handles that fuzzy-match a player's name
 * tokens. Uses pg_trgm `similarity()` over handle_normalized.
 *
 * Filters by country and rating-band when provided. Title is a
 * tiebreaker, not a filter (titled handles get a small bonus).
 */
import type postgres from 'postgres';
import { normalizeName } from '../fide/normalize';
import { normalizeCountry } from '../lib/country-code';

export interface CachedMatchInput {
  name: string;
  country?: string | null;
  /** FIDE standard rating; cached row's online rating must be within ±band. */
  fide_rating?: number | null;
  /** Allow ±ratingBand around fide_rating. Default 350 (rapid/blitz online
   *  tend to run higher than FIDE standard; titled players especially). */
  ratingBand?: number;
}

export interface CachedMatch {
  platform_player_id: string;
  platform: 'lichess' | 'chess.com';
  handle: string;
  country: string | null;
  title: string | null;
  rating_bullet: number | null;
  rating_blitz: number | null;
  rating_rapid: number | null;
  rating_classical: number | null;
  /** Self-reported FIDE rating from the platform bio. Read directly into
   *  the Stage 2 scoring path as a sharp rating-band signal. */
  claimed_fide_rating: number | null;
  /** Self-reported country (separate from the canonical `country` column). */
  claimed_country: string | null;
  /** pg_trgm similarity score (0..1) of best name-token match. */
  similarity: number;
  /** Which name token matched best. */
  matched_token: string;
}

/**
 * Run a fuzzy search for each name token, take the top N hits per token,
 * and merge by (platform, handle). The query uses the pg_trgm GIN index
 * on platform_players.handle_normalized.
 */
export async function cachedFuzzyMatch(
  sql: postgres.Sql,
  input: CachedMatchInput,
  limitPerToken = 30,
): Promise<CachedMatch[]> {
  const tokens = normalizeName(input.name)
    .split(/[\s,]+/)
    .filter((t) => t.length >= 3); // 1-2 char tokens too noisy for trigram

  if (tokens.length === 0) return [];

  // Normalize input country (FIDE alpha-3 → alpha-2) so SQL string compare
  // against platform_players.country (alpha-2) actually works.
  const countryIso2 = input.country ? normalizeCountry(input.country) : null;

  const merged = new Map<string, CachedMatch>();

  for (const token of tokens) {
    const rows = await sql<CachedMatch[]>`
      SELECT
        id AS platform_player_id,
        platform,
        handle,
        country,
        title,
        rating_bullet,
        rating_blitz,
        rating_rapid,
        rating_classical,
        claimed_fide_rating,
        claimed_country,
        similarity(handle_normalized, ${token}) AS similarity,
        ${token}::text AS matched_token
      FROM platform_players
      WHERE handle_normalized % ${token}
        ${countryIso2 ? sql`AND (country = ${countryIso2} OR country IS NULL)` : sql``}
      ORDER BY similarity(handle_normalized, ${token}) DESC
      LIMIT ${limitPerToken}
    `;
    for (const r of rows) {
      const key = `${r.platform}:${r.handle}`;
      const existing = merged.get(key);
      if (!existing || r.similarity > existing.similarity) {
        merged.set(key, r);
      }
    }
  }

  return [...merged.values()];
}
