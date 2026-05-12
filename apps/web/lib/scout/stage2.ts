/**
 * Web-side Stage 2 — calls the stage2_cached_match RPC against
 * platform_players and scores candidates. No probing (the web flow needs
 * sub-second latency; lazy enrichment happens in workers).
 *
 * If the cached corpus doesn't have a player, the user sees "no matches"
 * — they can then run the worker offline (or, later, kick off an Inngest
 * job to probe and notify).
 */
import { createAdminClient } from '@/lib/supabase/admin';
import { countryMatches, normalizeCountry } from './country-code';

export interface Stage2Input {
  name: string;
  country?: string | null;
  fide_rating?: number | null;
  title?: string | null;
}

export interface Stage2Candidate {
  platform: 'lichess' | 'chess.com';
  handle: string;
  confidence: number;
  reasons: string[];
  country: string | null;
  title: string | null;
  ratings: {
    bullet: number | null;
    blitz: number | null;
    rapid: number | null;
    classical: number | null;
  };
}

const STOP_WORDS = new Set(['jr', 'sr', 'iii', 'ii', 'iv']);

function normalizeName(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[',.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(name: string): string[] {
  return normalizeName(name)
    .split(/[\s,]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

function ratingBandMatch(
  fide: number | null | undefined,
  online: {
    bullet?: number | null;
    blitz?: number | null;
    rapid?: number | null;
    classical?: number | null;
  },
  band = 400,
): boolean | null {
  if (fide == null) return null;
  const ratings = [online.bullet, online.blitz, online.rapid, online.classical].filter(
    (r): r is number => typeof r === 'number',
  );
  if (ratings.length === 0) return null;
  const offset = 150;
  return ratings.some((r) => Math.abs(r - (fide + offset)) <= band);
}

interface ScoreInput {
  name_similarity: number;
  country_match: boolean | null;
  rating_band_match: boolean | null;
  title_match: boolean | null;
}

function score(input: ScoreInput): { confidence: number; reasons: string[] } {
  const reasons: string[] = [];
  const w = {
    name: 0.5,
    country: input.country_match === null ? 0 : 0.2,
    rating: input.rating_band_match === null ? 0 : 0.2,
    title: input.title_match === null ? 0 : 0.1,
  };
  const total = w.name + w.country + w.rating + w.title;
  if (total === 0) return { confidence: 0, reasons };
  let raw = w.name * Math.min(1, Math.max(0, input.name_similarity));
  reasons.push(`name match ${(input.name_similarity * 100).toFixed(0)}%`);
  if (input.country_match === true) {
    raw += w.country;
    reasons.push('country matches');
  } else if (input.country_match === false) {
    reasons.push('country mismatch');
  }
  if (input.rating_band_match === true) {
    raw += w.rating;
    reasons.push('rating in band');
  } else if (input.rating_band_match === false) {
    reasons.push('rating outside band');
  }
  if (input.title_match === true) {
    raw += w.title;
    reasons.push('titled');
  }
  return { confidence: raw / total, reasons };
}

interface RpcRow {
  platform_player_id: string;
  platform: 'lichess' | 'chess.com';
  handle: string;
  country: string | null;
  title: string | null;
  rating_bullet: number | null;
  rating_blitz: number | null;
  rating_rapid: number | null;
  rating_classical: number | null;
  sim: number;
  matched_token: string;
}

export async function runStage2Cached(input: Stage2Input): Promise<Stage2Candidate[]> {
  const nameTokens = tokens(input.name);
  if (nameTokens.length === 0) return [];

  const countryIso2 = input.country ? normalizeCountry(input.country) : null;
  const supabase = createAdminClient();

  const { data, error } = await supabase.rpc('stage2_cached_match', {
    name_tokens: nameTokens,
    country_filter: countryIso2,
    per_token_limit: 30,
  });
  if (error) throw new Error(`stage2_cached_match RPC failed: ${error.message}`);

  const rows = (data ?? []) as RpcRow[];
  const candidates: Stage2Candidate[] = rows.map((r) => {
    const s = score({
      name_similarity: r.sim,
      country_match: countryMatches(r.country, input.country),
      rating_band_match: ratingBandMatch(input.fide_rating, {
        bullet: r.rating_bullet,
        blitz: r.rating_blitz,
        rapid: r.rating_rapid,
        classical: r.rating_classical,
      }),
      title_match: r.title ? true : null,
    });
    return {
      platform: r.platform,
      handle: r.handle,
      confidence: s.confidence,
      reasons: [`fuzzy match on '${r.matched_token}'`, ...s.reasons],
      country: r.country,
      title: r.title,
      ratings: {
        bullet: r.rating_bullet,
        blitz: r.rating_blitz,
        rapid: r.rating_rapid,
        classical: r.rating_classical,
      },
    };
  });

  return candidates.sort((a, b) => b.confidence - a.confidence);
}
