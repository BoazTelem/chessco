/**
 * Pure types + helpers for federations — safe to import from client components.
 * Server-only fetcher lives in `federations.ts` (uses `next/headers` via Supabase).
 */

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

export const CONTINENT_LABELS: Record<string, string> = {
  EU: 'Europe',
  NA: 'North America',
  SA: 'South America',
  AS: 'Asia',
  AF: 'Africa',
  OC: 'Oceania',
  INT: 'International',
};

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
