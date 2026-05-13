/**
 * Lazy profile enrichment for candidates whose evidence row landed with
 * missing ratings or missing country.
 *
 * Stage 2 (name search) reads platform_players, so it inherits whatever
 * the country/titled crawler captured — usually decent coverage for
 * chess.com country pulls but no ratings, and partial coverage for
 * lichess. Stage 3 (sample-game) joins the games-corpus directly and
 * skips platform_players entirely, so its candidates always land with
 * all-null ratings AND null country.
 *
 * On match-page render we backfill against the public profile endpoints:
 *   chess.com  →  /pub/player/{handle} + /pub/player/{handle}/stats
 *   lichess    →  /api/user/{handle}
 *
 * Persisted into BOTH platform_players (so future Stage 2 runs benefit)
 * and the candidate's evidence (so subsequent renders don't re-fetch).
 * Best-effort: timeouts and 404s leave fields null and the UI hides what
 * it can't show. Runs in parallel — public endpoints are generous and we
 * cap candidates at 15 per query.
 */
import { createAdminClient } from '@/lib/supabase/admin';
import { chesscomRatings, fetchChesscomPlayer, fetchChesscomStats } from '@/lib/chesscom';

type Ratings = {
  bullet: number | null;
  blitz: number | null;
  rapid: number | null;
  classical: number | null;
};

interface EnrichableCandidate {
  id: number;
  platform: 'lichess' | 'chess.com';
  handle: string;
  evidence: {
    reasons: string[];
    country: string | null;
    title: string | null;
    ratings: Ratings;
    prose?: string | null;
  };
}

const PER_CANDIDATE_TIMEOUT_MS = 2_000;
const LICHESS_USER_AGENT = 'chessco-web/0.1 (+https://chessco.org)';

type FetchedProfile = {
  ratings: Ratings;
  country: string | null;
  title: string | null;
};

function allNullRatings(r: Ratings): boolean {
  return r.bullet == null && r.blitz == null && r.rapid == null && r.classical == null;
}

function needsEnrichment(c: EnrichableCandidate): boolean {
  return allNullRatings(c.evidence.ratings) || c.evidence.country == null;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, rej) => {
        t = setTimeout(() => rej(new Error('timeout')), ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

/** "https://api.chess.com/pub/country/IL" → "IL". */
function isoFromCountryUrl(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/country\/([A-Z]{2})$/i);
  return m?.[1]?.toUpperCase() ?? null;
}

async function fetchChesscomProfile(handle: string): Promise<FetchedProfile> {
  const [player, stats] = await Promise.all([
    fetchChesscomPlayer(handle),
    fetchChesscomStats(handle),
  ]);
  const r = chesscomRatings(stats);
  return {
    ratings: {
      bullet: r.rating_bullet ?? null,
      blitz: r.rating_blitz ?? null,
      rapid: r.rating_rapid ?? null,
      classical: r.rating_classical ?? null,
    },
    country: isoFromCountryUrl(player.country),
    title: player.title ?? null,
  };
}

async function fetchLichessProfile(handle: string): Promise<FetchedProfile> {
  const res = await fetch(
    `https://lichess.org/api/user/${encodeURIComponent(handle.toLowerCase())}`,
    {
      headers: { 'User-Agent': LICHESS_USER_AGENT, Accept: 'application/json' },
      cache: 'no-store',
    },
  );
  if (!res.ok) throw new Error(`lichess /api/user/${handle}: ${res.status}`);
  const u = (await res.json()) as {
    title?: string;
    perfs?: Record<string, { rating?: number; prov?: boolean }>;
    profile?: { country?: string };
  };
  // Provisional ratings are noisy until ~20 games — skip so we don't show
  // a 1500 placeholder next to a strong player's real blitz rating.
  const ratingOf = (p?: { rating?: number; prov?: boolean }): number | null => {
    if (!p || p.rating == null || p.prov) return null;
    return p.rating;
  };
  return {
    ratings: {
      bullet: ratingOf(u.perfs?.bullet),
      blitz: ratingOf(u.perfs?.blitz),
      rapid: ratingOf(u.perfs?.rapid),
      classical: ratingOf(u.perfs?.classical),
    },
    country: u.profile?.country?.toUpperCase() ?? null,
    title: u.title ?? null,
  };
}

export async function enrichCandidateProfiles(candidates: EnrichableCandidate[]): Promise<void> {
  const targets = candidates.filter(needsEnrichment);
  if (targets.length === 0) return;

  const admin = createAdminClient();

  await Promise.all(
    targets.map(async (c) => {
      let profile: FetchedProfile;
      try {
        profile = await withTimeout(
          c.platform === 'chess.com'
            ? fetchChesscomProfile(c.handle)
            : fetchLichessProfile(c.handle),
          PER_CANDIDATE_TIMEOUT_MS,
        );
      } catch {
        return;
      }

      // Only fill nulls — never overwrite an existing value (e.g. Stage 2
      // candidates whose country came from platform_players already).
      const nextRatings = allNullRatings(c.evidence.ratings) ? profile.ratings : c.evidence.ratings;
      const nextCountry = c.evidence.country ?? profile.country;
      const nextTitle = c.evidence.title ?? profile.title;

      const ratingsChanged = nextRatings !== c.evidence.ratings && !allNullRatings(profile.ratings);
      const countryChanged = nextCountry !== c.evidence.country;
      const titleChanged = nextTitle !== c.evidence.title;
      if (!ratingsChanged && !countryChanged && !titleChanged) return;

      c.evidence.ratings = nextRatings;
      c.evidence.country = nextCountry;
      c.evidence.title = nextTitle;

      const platformPlayersUpdate: Record<string, unknown> = {
        last_seen_at: new Date().toISOString(),
      };
      if (ratingsChanged) {
        platformPlayersUpdate.rating_bullet = nextRatings.bullet;
        platformPlayersUpdate.rating_blitz = nextRatings.blitz;
        platformPlayersUpdate.rating_rapid = nextRatings.rapid;
        platformPlayersUpdate.rating_classical = nextRatings.classical;
      }
      if (countryChanged) platformPlayersUpdate.country = nextCountry;
      if (titleChanged) platformPlayersUpdate.title = nextTitle;

      await Promise.all([
        admin
          .from('platform_players')
          .update(platformPlayersUpdate)
          .eq('platform', c.platform)
          .eq('handle', c.handle),
        admin.from('identification_candidates').update({ evidence: c.evidence }).eq('id', c.id),
      ]);
    }),
  );
}
