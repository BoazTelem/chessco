/**
 * Lichess handle search — lives in Cloud SQL games-corpus, not Supabase.
 *
 * The 1,400+ Lichess handles in our `handles` table come from monthly dump
 * ingest. They have no claimed_name, no country, no per-time-class rating;
 * we only know the handle string itself and an `avg_opponent_rating` from
 * style_features (used as a rough skill proxy in the result card).
 *
 * Matching is pure pg_trgm similarity against the lowercase handle, which
 * is enough to recover surname-style handles ("borisovich33", "magnusc",
 * "gelfand") that fold into the same name search the user does for FIDE.
 *
 * One return shape: HandleResult, so the existing HandleResultCard renders
 * both platforms uniformly. Null slots in the rating columns render as "—".
 */
import 'server-only';
import { getGamesDb } from '@/lib/games-db';
import type { HandleResult } from '@/app/scout/result-card';

/**
 * @param q  lowercased name fragment from the search box (>=2 chars).
 * @param limit  max rows to return; the page caps overall handles around 15
 *               combining lichess + chess.com.
 * @param minSim  trigram similarity floor — 0.3 matches forgivingly,
 *                0.5 is "looks like".
 */
export async function searchLichessHandlesByName(
  q: string,
  limit = 10,
  minSim = 0.3,
): Promise<HandleResult[]> {
  if (q.length < 2) return [];

  const sql = getGamesDb();
  type Row = {
    id: string;
    handle: string;
    games_seen: number;
    avg_opp: string | null;
    sim: string;
  };
  const rows = await sql<Row[]>`
    SELECT
      h.id,
      h.handle,
      h.games_seen,
      (sf.features->>'avg_opponent_rating') AS avg_opp,
      similarity(LOWER(h.handle), ${q})::text AS sim
    FROM handles h
    LEFT JOIN style_features sf ON sf.player_id = h.id
    WHERE h.platform = 'lichess'
      AND LOWER(h.handle) % ${q}
      AND similarity(LOWER(h.handle), ${q}) >= ${minSim}
    ORDER BY similarity(LOWER(h.handle), ${q}) DESC, h.games_seen DESC
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    id: r.id,
    platform: 'lichess' as const,
    handle: r.handle,
    claimed_name: null,
    country: null,
    title: null,
    // Stuff avg_opp into rating_blitz so the card surfaces a rating proxy.
    // It's our best single skill number for Lichess handles; users will read
    // it as "blitz-ish strength" which is roughly true for our corpus.
    rating_blitz: r.avg_opp ? Math.round(Number(r.avg_opp)) : null,
    rating_rapid: null,
    rating_classical: null,
    sim: Number(r.sim),
    matched_field: 'handle' as const,
  }));
}
