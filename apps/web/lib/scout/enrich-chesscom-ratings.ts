/**
 * Lazy /stats enrichment for chess.com candidates whose platform_players
 * row was seeded by the country crawler (handle + country only, no ratings).
 *
 * Stage 2 reads platform_players and snapshots ratings into
 * identification_candidates.evidence.ratings; when those are all null we
 * fetch chess.com's /pub/player/{handle}/stats live on match-page render,
 * persist into BOTH platform_players (so future Stage 2 runs benefit) and
 * identification_candidates.evidence (so subsequent renders of the same
 * query don't re-fetch).
 *
 * Best-effort: timeouts and 404s leave ratings null and the UI hides the
 * ratings block. Runs in parallel across candidates — chess.com /pub/stats
 * is generous and we expect at most ~5 candidates per query.
 */
import { createAdminClient } from '@/lib/supabase/admin';
import { chesscomRatings, fetchChesscomStats } from '@/lib/chesscom';

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

function allNull(r: Ratings): boolean {
  return r.bullet == null && r.blitz == null && r.rapid == null && r.classical == null;
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

export async function enrichChesscomRatings(candidates: EnrichableCandidate[]): Promise<void> {
  const targets = candidates.filter(
    (c) => c.platform === 'chess.com' && allNull(c.evidence.ratings),
  );
  if (targets.length === 0) return;

  const admin = createAdminClient();

  await Promise.all(
    targets.map(async (c) => {
      let ratings: Ratings;
      try {
        const stats = await withTimeout(fetchChesscomStats(c.handle), PER_CANDIDATE_TIMEOUT_MS);
        const r = chesscomRatings(stats);
        ratings = {
          bullet: r.rating_bullet ?? null,
          blitz: r.rating_blitz ?? null,
          rapid: r.rating_rapid ?? null,
          classical: r.rating_classical ?? null,
        };
      } catch {
        return;
      }
      if (allNull(ratings)) return;

      c.evidence.ratings = ratings;

      await Promise.all([
        admin
          .from('platform_players')
          .update({
            rating_bullet: ratings.bullet,
            rating_blitz: ratings.blitz,
            rating_rapid: ratings.rapid,
            rating_classical: ratings.classical,
            last_seen_at: new Date().toISOString(),
          })
          .eq('platform', 'chess.com')
          .eq('handle', c.handle),
        admin.from('identification_candidates').update({ evidence: c.evidence }).eq('id', c.id),
      ]);
    }),
  );
}
