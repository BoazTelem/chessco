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
import { runLazyProbe, type ProbeHit } from './lazy-probe';

export interface Stage2Input {
  name: string;
  country?: string | null;
  fide_rating?: number | null;
  title?: string | null;
  /** Optional birth year — feeds the lazy handle synthesizer
   *  (e.g. "carlsen90"). Skip if unknown. */
  birth_year?: number | null;
  /** federation_players.id of the anchor — used by the cross-reference
   *  filter to drop candidates whose claimed_name resolves to a DIFFERENT
   *  FIDE-registered player. */
  federation_player_id?: string | null;
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
  /** Did we have enough rating data on both sides to check, and did it match?
   *  Used by the implausibility filter — out-of-band candidates whose anchor
   *  is a strong-rated player (FIDE >= 1800) get hard-dropped. */
  rating_band_match: boolean | null;
  /** Real name claimed by the platform profile, if any. */
  claimed_name: string | null;
  /** If the claimed_name fuzzy-matched a federation_players row, what id? */
  claimed_federation_match: {
    federation_player_id: string;
    federation_id: string;
    federation_player_id_str: string;
    matched_name: string;
    sim: number;
  } | null;
}

/**
 * Drop candidates whose online ratings are clearly too low for the
 * FIDE-rated anchor. Separate from the rating-band scoring bonus —
 * the bonus uses a tight ±400 band for precision; this filter uses
 * a loose "more than 500 below FIDE" gap for hard removal.
 *
 * A 2635 GM cannot be a 1500-rated handle, even with a perfect name
 * match. But a 2635 GM CAN be a 2150 chess.com handle (some pros don't
 * grind online), so we don't drop those — only the impossible cases.
 *
 * No filtering for amateur anchors (fide < 1800) — name mismatches are
 * common and rating gaps are noisier.
 */
const STRONG_FIDE_THRESHOLD = 1800;
const MAX_RATING_GAP = 500;
function isImplausibleByRating(
  fide: number | null | undefined,
  online: {
    bullet: number | null;
    blitz: number | null;
    rapid: number | null;
    classical: number | null;
  },
): boolean {
  if (fide == null || fide < STRONG_FIDE_THRESHOLD) return false;
  const ratings = [online.bullet, online.blitz, online.rapid, online.classical].filter(
    (r): r is number => typeof r === 'number',
  );
  if (ratings.length === 0) return false; // no data → can't judge → keep
  const maxOnline = Math.max(...ratings);
  return maxOnline < fide - MAX_RATING_GAP;
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

/**
 * If the handle contains EVERY name token as a substring, it's almost
 * certainly the same person — `magnuscarlsen` for "Carlsen, Magnus",
 * `hikarunakamura` for "Nakamura, Hikaru". Per-token trigram similarity
 * undersells these (single-token max ≈ 0.4) because the handle is twice
 * as long as either token alone. Boost to 1.0 when containment is full.
 *
 * Requires ≥2 tokens so single-surname inputs ("Carlsen") don't
 * trivially match every handle containing "carlsen".
 */
function compoundContainmentSim(handleNormalized: string, nameTokens: string[]): number {
  if (nameTokens.length < 2) return 0;
  return nameTokens.every((t) => handleNormalized.includes(t)) ? 1 : 0;
}

/** GM > IM > FM > CM > NM > WGM/WIM/WFM/WCM > untitled.
 *  Returns true only when the candidate's title is at least as strong as
 *  the anchor's — a CM is not a GM, so a GM anchor matching a CM handle
 *  should NOT get the title bonus. */
const TITLE_RANK: Record<string, number> = {
  GM: 6,
  IM: 5,
  FM: 4,
  CM: 3,
  NM: 2,
  WGM: 5,
  WIM: 4,
  WFM: 3,
  WCM: 2,
};
function titleMatches(
  candidateTitle: string | null | undefined,
  anchorTitle: string | null | undefined,
): boolean | null {
  if (!anchorTitle) {
    // No anchor title (amateur or unknown): any title is a mild positive signal.
    return candidateTitle ? true : null;
  }
  if (!candidateTitle) return null; // no signal from candidate
  const a = TITLE_RANK[anchorTitle.toUpperCase()] ?? 0;
  const c = TITLE_RANK[candidateTitle.toUpperCase()] ?? 0;
  return c >= a;
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
  claimed_name: string | null;
  claimed_name_normalized: string | null;
}

interface FedMatchRow {
  name_input: string;
  federation_player_id: string;
  federation_id: string;
  federation_player_id_str: string;
  matched_name: string;
  sim: number;
}

export async function runStage2Cached(input: Stage2Input): Promise<Stage2Candidate[]> {
  const nameTokens = tokens(input.name);
  if (nameTokens.length === 0) return [];

  const countryIso2 = input.country ? normalizeCountry(input.country) : null;
  const supabase = createAdminClient();

  // Run the cached corpus match and the lazy name-probe in parallel. The
  // probe catches handles the country crawler missed (chess.com caps at
  // ~10k handles per ISO, so most players are uncached). Failures in the
  // lazy probe are swallowed inside runLazyProbe and surface as [].
  const [cachedRes, lazyHits] = await Promise.all([
    supabase.rpc('stage2_cached_match', {
      name_tokens: nameTokens,
      country_filter: countryIso2,
      per_token_limit: 30,
    }),
    runLazyProbe({ name: input.name, birthYear: input.birth_year ?? null }).catch(
      () => [] as ProbeHit[],
    ),
  ]);
  if (cachedRes.error)
    throw new Error(`stage2_cached_match RPC failed: ${cachedRes.error.message}`);

  const cachedRows = (cachedRes.data ?? []) as RpcRow[];
  const rows = mergeWithLazyHits(cachedRows, lazyHits, nameTokens);

  // ---- Cross-reference: for any candidate with a claimed_name, find the
  // best federation_players match and check whether it's a DIFFERENT player
  // than our anchor. One batched RPC call instead of N round-trips.
  const claimedNames = Array.from(
    new Set(
      rows
        .map((r) => r.claimed_name_normalized)
        .filter((n): n is string => typeof n === 'string' && n.length > 0),
    ),
  );
  const fedMatchByName = new Map<string, FedMatchRow>();
  if (claimedNames.length > 0) {
    const { data: fedData, error: fedErr } = await supabase.rpc('match_federation_players_batch', {
      names: claimedNames,
    });
    if (fedErr) throw new Error(`match_federation_players_batch failed: ${fedErr.message}`);
    for (const row of (fedData ?? []) as FedMatchRow[]) {
      fedMatchByName.set(row.name_input, row);
    }
  }

  const candidates: Stage2Candidate[] = rows.map((r) => {
    const rbm = ratingBandMatch(input.fide_rating, {
      bullet: r.rating_bullet,
      blitz: r.rating_blitz,
      rapid: r.rating_rapid,
      classical: r.rating_classical,
    });
    const compoundSim = compoundContainmentSim(normalizeName(r.handle), nameTokens);
    const effectiveSim = Math.max(r.sim, compoundSim);
    const s = score({
      name_similarity: effectiveSim,
      country_match: countryMatches(r.country, input.country),
      rating_band_match: rbm,
      title_match: titleMatches(r.title, input.title),
    });
    const fedMatch = r.claimed_name_normalized
      ? (fedMatchByName.get(r.claimed_name_normalized) ?? null)
      : null;
    const matchedDisplay = compoundSim > r.sim ? nameTokens.join(' ') : r.matched_token;
    return {
      platform: r.platform,
      handle: r.handle,
      confidence: s.confidence,
      reasons: [`fuzzy match on '${matchedDisplay}'`, ...s.reasons],
      country: r.country,
      title: r.title,
      ratings: {
        bullet: r.rating_bullet,
        blitz: r.rating_blitz,
        rapid: r.rating_rapid,
        classical: r.rating_classical,
      },
      rating_band_match: rbm,
      claimed_name: r.claimed_name,
      claimed_federation_match: fedMatch,
    };
  });

  return candidates
    .filter((c) => !isImplausibleByRating(input.fide_rating, c.ratings))
    .filter((c) => !isDifferentFederationPlayer(c, input.federation_player_id))
    .sort((a, b) => b.confidence - a.confidence);
}

/**
 * If the candidate's claimed_name resolves to a federation_players row
 * with high similarity AND that row's id is not our anchor, this is
 * provably a different person. Drop.
 *
 * Threshold: claimed_name → federation match similarity >= 0.7. Lower
 * thresholds risk false positives (common surnames like "Smith"). 0.7
 * still catches "Boris Kantsler" vs "Kantsler Boris" (trigram-symmetric).
 */
const DIFFERENT_PERSON_SIMILARITY = 0.7;
function isDifferentFederationPlayer(
  candidate: Stage2Candidate,
  anchorFederationPlayerId: string | null | undefined,
): boolean {
  const m = candidate.claimed_federation_match;
  if (!m) return false;
  if (m.sim < DIFFERENT_PERSON_SIMILARITY) return false;
  if (!anchorFederationPlayerId) return false;
  if (m.federation_player_id === anchorFederationPlayerId) return false;
  return true;
}

/**
 * Merge lazy probe hits with cached RPC rows. Lazy hits were synthesized
 * from the FIDE name, so by construction they contain the name tokens —
 * we synthesize sim = 1.0 so the per-token scorer treats them as exact
 * name matches (compoundContainmentSim catches this anyway, but setting
 * sim explicit avoids edge cases with single-token names). Dedup by
 * (platform, handle) — if a handle is in both sets, the lazy version
 * wins (it has fresher profile data).
 */
function mergeWithLazyHits(cached: RpcRow[], lazy: ProbeHit[], nameTokens: string[]): RpcRow[] {
  if (lazy.length === 0) return cached;
  const matchedDisplay = nameTokens.join(' ');
  const seen = new Set<string>();
  const out: RpcRow[] = [];
  for (const h of lazy) {
    const key = `${h.platform}:${h.handle_normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      platform_player_id: '',
      platform: h.platform,
      handle: h.handle,
      country: h.country,
      title: h.title,
      rating_bullet: h.rating_bullet,
      rating_blitz: h.rating_blitz,
      rating_rapid: h.rating_rapid,
      rating_classical: h.rating_classical,
      sim: 1,
      matched_token: matchedDisplay,
      claimed_name: h.claimed_name,
      claimed_name_normalized: h.claimed_name
        ? h.claimed_name
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9 ]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim() || null
        : null,
    });
  }
  for (const r of cached) {
    const key = `${r.platform}:${r.handle.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
