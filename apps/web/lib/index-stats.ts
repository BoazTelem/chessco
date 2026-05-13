/**
 * Live aggregate counts of indexed players. Backed by the
 * `public_index_stats` Postgres RPC (SECURITY DEFINER, bypasses RLS).
 *
 * Callers should set `export const revalidate = N` on the route so the
 * count refreshes on a schedule rather than every request. The home
 * page revalidates daily; /scout revalidates hourly.
 *
 * Falls back to a sensible static estimate if the RPC fails so the page
 * doesn't blank on a transient DB hiccup.
 */
import { createClient } from '@/lib/supabase/server';

export type IndexStats = {
  fide: number;
  icf: number;
  uscf: number;
  federationTotal: number;
  platformTotal: number;
  total: number;
};

const FALLBACK: IndexStats = {
  fide: 755_081,
  icf: 6_818,
  uscf: 0,
  federationTotal: 761_899,
  platformTotal: 106_296,
  total: 868_195,
};

type RpcShape = {
  fide?: number;
  icf?: number;
  uscf?: number;
  federation_total?: number;
  platform_total?: number;
  total?: number;
};

export async function getIndexStats(): Promise<IndexStats> {
  try {
    const supabase = await createClient();
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
    };
  } catch {
    return FALLBACK;
  }
}
