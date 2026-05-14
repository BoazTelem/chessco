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
 */
import { unstable_cache } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

export interface FederationOption {
  code: string;
  name: string;
  country: string | null;
  iso2: string | null;
  iso3: string | null;
  continent: 'AF' | 'AS' | 'EU' | 'NA' | 'OC' | 'SA' | null;
  scrapeStrategy:
    | 'dump'
    | 'fetch-html'
    | 'aspnet'
    | 'spa'
    | 'api'
    | 'cloudflare'
    | 'placeholder'
    | null;
  estPlayerCount: number | null;
  ratingListUrl: string | null;
  lastSyncedAt: string | null;
  active: boolean;
}

const CONTINENT_ORDER: Record<string, number> = {
  EU: 0,
  NA: 1,
  SA: 2,
  AS: 3,
  AF: 4,
  OC: 5,
};

export const CONTINENT_LABELS: Record<string, string> = {
  EU: 'Europe',
  NA: 'North America',
  SA: 'South America',
  AS: 'Asia',
  AF: 'Africa',
  OC: 'Oceania',
  INT: 'International',
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

/**
 * Group federations by continent for `<optgroup>` rendering.
 * FIDE (no continent) lands in 'INT' first.
 */
export function groupFederationsByContinent(
  feds: FederationOption[],
): { continent: string; label: string; items: FederationOption[] }[] {
  const groups = new Map<string, FederationOption[]>();
  for (const f of feds) {
    const key = f.continent ?? 'INT';
    const list = groups.get(key) ?? [];
    list.push(f);
    groups.set(key, list);
  }
  const order = ['INT', 'EU', 'NA', 'SA', 'AS', 'AF', 'OC'];
  return order
    .filter((k) => groups.has(k))
    .map((k) => ({
      continent: k,
      label: CONTINENT_LABELS[k] ?? k,
      items: groups.get(k)!,
    }));
}

/**
 * Lookup helper used by the [code] route. Returns null for unknown codes.
 * Also resolves FIDE-alpha-3 aliases (USA → USCF, ENG → ECF, …).
 */
export function findFederation(
  feds: FederationOption[],
  rawCode: string,
): { canonical: string; row: FederationOption } | null {
  const code = rawCode.trim().toUpperCase();
  const direct = feds.find((f) => f.code === code);
  if (direct) return { canonical: direct.code, row: direct };

  const aliases: Record<string, string> = {
    USA: 'USCF',
    ENG: 'ECF',
    GER: 'DSB',
    FRA: 'FFE',
    ITA: 'FSI',
    ISR: 'ICF',
  };
  const aliased = aliases[code];
  if (aliased) {
    const row = feds.find((f) => f.code === aliased);
    if (row) return { canonical: row.code, row };
  }
  return null;
}
