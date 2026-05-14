/**
 * Server-side cached fetcher for the `federations` table.
 *
 * Used by:
 *   - `/scout` page (chip filter dropdown — 199 entries grouped by continent)
 *   - `/scout/federation/[code]` (header metadata, peer cross-links)
 *   - `/sitemap.xml` (route enumeration)
 *
 * Cached for 1h via `unstable_cache`. The federations table changes ~monthly
 * when a new wave ships, so 1h is plenty fresh. Tag-invalidate via
 * `revalidateTag('federations')` from a webhook if instant refresh is needed.
 *
 * Pure types/helpers (importable from client components) live in
 * `federations-shared.ts` and are re-exported here for backward compatibility.
 */
import { unstable_cache } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import type { FederationOption } from './federations-shared';

export type { FederationOption } from './federations-shared';
export {
  CONTINENT_LABELS,
  groupFederationsByContinent,
  findFederation,
} from './federations-shared';

const CONTINENT_ORDER: Record<string, number> = {
  EU: 0,
  NA: 1,
  SA: 2,
  AS: 3,
  AF: 4,
  OC: 5,
};

async function fetchFederations(): Promise<FederationOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('federations')
    .select(
      'id, name, country, iso2, iso3, continent, scrape_strategy, est_player_count, rating_list_url, last_synced_at, active',
    );
  if (error) {
    // Surface as empty rather than crash the page; the filter degrades gracefully.
    console.error('[federations] fetch failed:', error.message);
    return [];
  }
  const rows: FederationOption[] = (data ?? []).map((r) => ({
    code: r.id as string,
    name: r.name as string,
    country: (r.country as string | null) ?? null,
    iso2: (r.iso2 as string | null) ?? null,
    iso3: (r.iso3 as string | null) ?? null,
    continent: (r.continent as FederationOption['continent']) ?? null,
    scrapeStrategy: (r.scrape_strategy as FederationOption['scrapeStrategy']) ?? null,
    estPlayerCount: (r.est_player_count as number | null) ?? null,
    ratingListUrl: (r.rating_list_url as string | null) ?? null,
    lastSyncedAt: (r.last_synced_at as string | null) ?? null,
    active: Boolean(r.active),
  }));
  // Sort: continent group, then est_player_count DESC NULLS LAST, then name
  rows.sort((a, b) => {
    const ag = CONTINENT_ORDER[a.continent ?? 'INT'] ?? 99;
    const bg = CONTINENT_ORDER[b.continent ?? 'INT'] ?? 99;
    if (ag !== bg) return ag - bg;
    const ac = a.estPlayerCount ?? -1;
    const bc = b.estPlayerCount ?? -1;
    if (ac !== bc) return bc - ac;
    return a.name.localeCompare(b.name);
  });
  return rows;
}

export const getFederations = unstable_cache(fetchFederations, ['federations-list-v1'], {
  revalidate: 3600,
  tags: ['federations'],
});
