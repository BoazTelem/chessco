/**
 * Live aggregate counts of indexed players. Backed by the
 * `public_index_stats` Postgres RPC (SECURITY DEFINER, bypasses RLS).
 *
 * Cached at the data layer via `unstable_cache` (1-hour TTL) rather than
 * via route-level `revalidate`. This lets callers compose this with
 * auth-dependent UI (e.g. the home page reads cookies for getUser());
 * mixing `cookies()` + page-level `revalidate` was making logged-in
 * users see the logged-out shell of the page on return visits.
 *
 * Uses a cookieless anon client because the RPC is SECURITY DEFINER —
 * no auth context needed, and unstable_cache forbids cookies() inside.
 *
 * Falls back to a sensible static estimate if the RPC fails so the page
 * doesn't blank on a transient DB hiccup.
 */
import { unstable_cache } from 'next/cache';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

export type IndexStats = {
  fide: number;
  icf: number;
  uscf: number;
  federationTotal: number;
  platformTotal: number;
  total: number;
  /** Live distinct chess.com handles in the games-corpus (separate from
   *  platform_players seed). Sourced from the latest corpus_index_counts
   *  snapshot, written hourly by Inngest. */
  chesscomHandles: number;
  /** Live distinct Lichess handles, same source. */
  lichessHandles: number;
  /** Total games ingested per source, latest snapshot. */
  chesscomGames: number;
  lichessGames: number;
};

const FALLBACK: IndexStats = {
  fide: 755_081,
  icf: 6_818,
  uscf: 0,
  federationTotal: 761_899,
  platformTotal: 106_296,
  total: 868_195,
  chesscomHandles: 0,
  lichessHandles: 0,
  chesscomGames: 0,
  lichessGames: 0,
};

type RpcShape = {
  fide?: number;
  icf?: number;
  uscf?: number;
  federation_total?: number;
  platform_total?: number;
  total?: number;
  chesscom_handles?: number | null;
  lichess_handles?: number | null;
  chesscom_games?: number | null;
  lichess_games?: number | null;
};

async function fetchIndexStats(): Promise<IndexStats> {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) return FALLBACK;
    const supabase = createSupabaseClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supabase.rpc('public_index_stats');
    if (error || !data) return FALLBACK;
    const r = data as RpcShape;
    return {
      fide: r.fide ?? FALLBACK.fide,
      icf: r.icf ?? FALLBACK.icf,
      uscf: r.uscf ?? FALLBACK.uscf,
      federationTotal: r.federation_total ?? FALLBACK.federationTotal,
      platformTotal: r.platform_total ?? FALLBACK.platformTotal,
      total: r.total ?? FALLBACK.total,
      chesscomHandles: r.chesscom_handles ?? FALLBACK.chesscomHandles,
      lichessHandles: r.lichess_handles ?? FALLBACK.lichessHandles,
      chesscomGames: r.chesscom_games ?? FALLBACK.chesscomGames,
      lichessGames: r.lichess_games ?? FALLBACK.lichessGames,
    };
  } catch {
    return FALLBACK;
  }
}

export const getIndexStats = unstable_cache(fetchIndexStats, ['public-index-stats'], {
  revalidate: 3600,
  tags: ['index-stats'],
});
