import { unstable_cache } from 'next/cache';
import { createAdminClient } from '@/lib/supabase/admin';

export type IndexedPlayerCounts = {
  fide: number;
  chesscom: number;
  lichess: number;
  total: number;
};

const FALLBACK: IndexedPlayerCounts = {
  fide: 755_081,
  chesscom: 0,
  lichess: 0,
  total: 755_081,
};

async function fetchIndexedPlayerCounts(): Promise<IndexedPlayerCounts> {
  const supabase = createAdminClient();

  const [fideRes, chesscomRes, lichessRes] = await Promise.all([
    supabase.from('federation_players').select('*', { count: 'exact', head: true }),
    supabase
      .from('platform_players')
      .select('*', { count: 'exact', head: true })
      .eq('platform', 'chess.com'),
    supabase
      .from('platform_players')
      .select('*', { count: 'exact', head: true })
      .eq('platform', 'lichess'),
  ]);

  if (fideRes.error || chesscomRes.error || lichessRes.error) {
    return FALLBACK;
  }

  const fide = fideRes.count ?? 0;
  const chesscom = chesscomRes.count ?? 0;
  const lichess = lichessRes.count ?? 0;
  return { fide, chesscom, lichess, total: fide + chesscom + lichess };
}

export const getIndexedPlayerCounts = unstable_cache(
  fetchIndexedPlayerCounts,
  ['scout', 'indexed-player-counts', 'v1'],
  { revalidate: 3600, tags: ['indexed-player-counts'] },
);
