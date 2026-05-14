import { cache } from 'react';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { isUuid, parseFederationPlayerId } from './slug';

export type FederationPlayer = {
  id: string;
  federation_id: string;
  federation_player_id: string;
  name: string;
  country: string | null;
  title: string | null;
  rating_standard: number | null;
  rating_rapid: number | null;
  rating_blitz: number | null;
  birth_year: number | null;
  last_updated_at: string;
};

const SELECT_COLS =
  'id, federation_id, federation_player_id, name, country, title, rating_standard, rating_rapid, rating_blitz, birth_year, last_updated_at';

/**
 * Cookieless anon client — federation_players has public RLS
 * (`federation_players_select_public USING (true)`), so no auth context
 * is needed. Mirrors the pattern in lib/index-stats.ts so OG images and
 * sitemap chunks can resolve players without touching cookies().
 */
function anon() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Resolve a `/p/[player_id]` param to a federation player.
 * Param can be a UUID (legacy) or a slug ending in `-{fed}-{id}`.
 * Wrapped in React `cache()` so generateMetadata + the page render share
 * a single Supabase round-trip per request.
 */
export const getPlayerByParam = cache(async (param: string): Promise<FederationPlayer | null> => {
  const sb = anon();
  if (!sb) return null;

  if (isUuid(param)) {
    const { data } = await sb
      .from('federation_players')
      .select(SELECT_COLS)
      .eq('id', param)
      .maybeSingle();
    return (data as FederationPlayer | null) ?? null;
  }

  const parsed = parseFederationPlayerId(param);
  if (!parsed) return null;

  const { data } = await sb
    .from('federation_players')
    .select(SELECT_COLS)
    .eq('federation_id', parsed.federation_id)
    .eq('federation_player_id', parsed.federation_player_id)
    .maybeSingle();

  return (data as FederationPlayer | null) ?? null;
});
