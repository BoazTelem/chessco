/**
 * Readers for benchmark artifacts stored in Supabase by the eval workers
 * (apps/workers/src/eval/coverage-stats.ts and sparse-cascade-benchmark.ts
 * call publishBenchmarkArtifact after each run).
 *
 * Same caching shape as lib/index-stats.ts: unstable_cache with a 1h TTL,
 * cookieless anon client (table has an anon SELECT RLS policy and the
 * payloads are non-sensitive aggregates).
 */
import { unstable_cache } from 'next/cache';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

export type BenchmarkArtifact<T> = {
  data: T;
  refreshedAt: string;
};

async function fetchLatest<T>(kind: string): Promise<BenchmarkArtifact<T> | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  try {
    const supabase = createSupabaseClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supabase
      .from('benchmark_artifacts')
      .select('data, refreshed_at')
      .eq('kind', kind)
      .order('refreshed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return { data: data.data as T, refreshedAt: data.refreshed_at as string };
  } catch {
    return null;
  }
}

export const getCoverageArtifact = unstable_cache(
  async <T>() => fetchLatest<T>('coverage_stats'),
  ['benchmark-artifact', 'coverage_stats'],
  { revalidate: 3600, tags: ['benchmark-artifacts'] },
);

export const getSparseCascadeArtifact = unstable_cache(
  async <T>() => fetchLatest<T>('sparse_cascade'),
  ['benchmark-artifact', 'sparse_cascade'],
  { revalidate: 3600, tags: ['benchmark-artifacts'] },
);

export const getLegacyArtifact = unstable_cache(
  async <T>() => fetchLatest<T>('legacy_repertoire'),
  ['benchmark-artifact', 'legacy_repertoire'],
  { revalidate: 3600, tags: ['benchmark-artifacts'] },
);
