/**
 * Stage 2 — handle candidate generation.
 *
 * Inputs:
 *   - normalized real name (Lastname Firstname)
 *   - optional country (ISO), birth year, FIDE rating, title
 *
 * Outputs a ranked list of (platform, handle, confidence, reasons).
 *
 * Pipeline:
 *   1. cachedFuzzyMatch on platform_players via pg_trgm
 *   2. hypothesizeHandles → for top-K not already in cache, probe both APIs
 *   3. Upsert positive probe results into platform_players
 *   4. Score everything, rank top N
 */
import type postgres from 'postgres';
import { countryMatches } from '../lib/country-code';
import { cachedFuzzyMatch } from './cached-match';
import { hypothesizeHandles } from './hypothesize';
import { probeChesscom, probeLichess } from './probe';
import { ratingBandMatch, score } from './score';

export interface Stage2Input {
  name: string;
  country?: string | null;
  birth_year?: number | null;
  fide_rating?: number | null;
  title?: string | null;
  /** Cap on hypothesized handles to probe per platform. Default 8 to keep
   *  end-to-end Stage 2 runtime under ~5s. */
  maxProbesPerPlatform?: number;
}

export interface Stage2Candidate {
  platform: 'lichess' | 'chess.com';
  handle: string;
  confidence: number;
  reasons: string[];
  source: 'cached' | 'probed';
  ratings?: { bullet?: number; blitz?: number; rapid?: number; classical?: number };
  country?: string | null;
  title?: string | null;
}

export async function runStage2(sql: postgres.Sql, input: Stage2Input): Promise<Stage2Candidate[]> {
  const maxProbes = input.maxProbesPerPlatform ?? 8;

  // ---- 1. Cached fuzzy match ---------------------------------------------
  const cached = await cachedFuzzyMatch(sql, {
    name: input.name,
    country: input.country,
    fide_rating: input.fide_rating,
  });

  const candidates = new Map<string, Stage2Candidate>();

  for (const c of cached) {
    const key = `${c.platform}:${c.handle}`;
    const ratings = {
      bullet: c.rating_bullet ?? undefined,
      blitz: c.rating_blitz ?? undefined,
      rapid: c.rating_rapid ?? undefined,
      classical: c.rating_classical ?? undefined,
    };
    const s = score({
      name_similarity: c.similarity,
      country_match: countryMatches(c.country, input.country),
      rating_band_match: ratingBandMatch(input.fide_rating, {
        bullet: c.rating_bullet,
        blitz: c.rating_blitz,
        rapid: c.rating_rapid,
        classical: c.rating_classical,
      }),
      title_match: c.title ? c.title === (input.title ?? c.title) : null,
    });
    candidates.set(key, {
      platform: c.platform,
      handle: c.handle,
      confidence: s.confidence,
      reasons: [`cached row (${c.matched_token})`, ...s.reasons],
      source: 'cached',
      ratings,
      country: c.country,
      title: c.title,
    });
  }

  // ---- 2. Hypothesize + probe --------------------------------------------
  const hypotheses = hypothesizeHandles(input);

  // Filter out anything we already have cached on either platform.
  const toProbe = hypotheses.filter(
    (h) => !candidates.has(`lichess:${h.handle}`) && !candidates.has(`chess.com:${h.handle}`),
  );

  // Probe a small bounded set — top patterns first (last, first, first_last, ...).
  for (const platform of ['lichess', 'chess.com'] as const) {
    let probed = 0;
    for (const h of toProbe) {
      if (probed >= maxProbes) break;
      probed++;
      try {
        const result =
          platform === 'lichess' ? await probeLichess(h.handle) : await probeChesscom(h.handle);
        if (!result.exists) continue;

        const insert = sql as unknown as (
          rows: object[],
          ...cols: string[]
        ) => postgres.Helper<object[]>;
        // Upsert into platform_players so the next query hits the cache.
        await sql`
          INSERT INTO platform_players
            ${insert(
              [
                {
                  platform: result.platform,
                  handle: result.handle,
                  handle_normalized: result.handle,
                  country: result.country ?? null,
                  title: result.title ?? null,
                  rating_bullet: result.ratings?.bullet ?? null,
                  rating_blitz: result.ratings?.blitz ?? null,
                  rating_rapid: result.ratings?.rapid ?? null,
                  rating_classical: result.ratings?.classical ?? null,
                  pulled_via: 'lazy',
                  raw: JSON.stringify(result.raw ?? {}),
                },
              ],
              'platform',
              'handle',
              'handle_normalized',
              'country',
              'title',
              'rating_bullet',
              'rating_blitz',
              'rating_rapid',
              'rating_classical',
              'pulled_via',
              'raw',
            )}
          ON CONFLICT (platform, handle) DO UPDATE SET
            country = COALESCE(EXCLUDED.country, platform_players.country),
            title = COALESCE(EXCLUDED.title, platform_players.title),
            rating_bullet = COALESCE(EXCLUDED.rating_bullet, platform_players.rating_bullet),
            rating_blitz = COALESCE(EXCLUDED.rating_blitz, platform_players.rating_blitz),
            rating_rapid = COALESCE(EXCLUDED.rating_rapid, platform_players.rating_rapid),
            rating_classical = COALESCE(EXCLUDED.rating_classical, platform_players.rating_classical),
            last_seen_at = NOW()
        `;

        const s = score({
          name_similarity: 0.95, // hypothesized handle matched an expected pattern
          country_match: countryMatches(result.country, input.country),
          rating_band_match: ratingBandMatch(input.fide_rating, result.ratings ?? {}),
          title_match: result.title ? true : null,
        });

        candidates.set(`${result.platform}:${result.handle}`, {
          platform: result.platform,
          handle: result.handle,
          confidence: s.confidence,
          reasons: [`probed pattern '${h.pattern}'`, ...s.reasons],
          source: 'probed',
          ratings: result.ratings,
          country: result.country,
          title: result.title,
        });
      } catch (err) {
        console.warn(`  probe ${platform}/${h.handle} failed:`, (err as Error).message);
      }
    }
  }

  return [...candidates.values()].sort((a, b) => b.confidence - a.confidence);
}
