import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ResultCard } from '../../result-card';
import type { SearchResult } from '../../types';
import { createClient } from '@/lib/supabase/server';
import { findFederation, getFederations } from '@/lib/scout/federations';

const PAGE_SIZE = 50;

/**
 * Federation roster page: `/scout/federation/[code]`.
 *
 * Shipped 2026-05-14 as part of the Phase 0 W7 expansion. Renders one of:
 *   - Live native roster (federation has its own scraper, e.g. FIDE, ICF)
 *   - FIDE-slice fallback (federation has no scraper yet but FIDE rates its
 *     players (most of the 199; e.g. /scout/federation/GER shows FIDE rows
 *     filtered by country_iso2(country)='DE')
 *   - "No data yet" placeholder (tiny federations with no FIDE coverage)
 *
 * Canonical URL: uppercase 3-letter code. Lower/mixed-case + FIDE alpha-3
 * aliases (USA → USCF, ENG → ECF, GER → DSB, …) 301-redirect to canonical.
 */

type Params = { code: string };
type SearchParams = { page?: string };

export const revalidate = 86_400; // 24h ISR; federations refresh monthly at most

export async function generateStaticParams(): Promise<Params[]> {
  // Build static pages for active federations (the only ones with live data).
  // Inactive federations render on-demand via ISR; FIDE-slice still loads fast.
  const feds = await getFederations();
  return feds.filter((f) => f.active).map((f) => ({ code: f.code }));
}

export async function generateMetadata({ params }: { params: Promise<Params> }) {
  const { code } = await params;
  const feds = await getFederations();
  const found = findFederation(feds, code);
  if (!found) return { title: 'Federation not found | Chessco' };
  const { row } = found;
  return {
    title: `${row.name}: chess ratings | Chessco`,
    description: row.active
      ? `${row.name} (${row.code}): official federation rating list, ${row.estPlayerCount?.toLocaleString() ?? '-'} players. Search by name, identify online accounts.`
      : `${row.name} (${row.code}): chess players FIDE attributes to this federation. ${row.name}'s own list not yet integrated; shown via FIDE.`,
    openGraph: {
      title: `${row.name}: chess ratings`,
      type: 'website',
    },
  };
}

export default async function FederationRosterPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<SearchParams>;
}) {
  const { code: rawCode } = await params;
  const { page: pageRaw } = await searchParams;
  const feds = await getFederations();
  const found = findFederation(feds, rawCode);
  if (!found) notFound();

  // Canonicalize URL: alias → canonical; lower/mixed-case → uppercase.
  if (found.canonical !== rawCode) {
    redirect(`/scout/federation/${found.canonical}`);
  }

  const fed = found.row;
  const page = Math.max(1, parseInt(pageRaw ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const supabase = await createClient();

  // Decide data source: native if active, else FIDE-slice via iso2 country.
  // For the FIDE row itself, "active=true" means we query FIDE players directly.
  const useNative = fed.active;
  const federationFilter = useNative ? fed.code : 'FIDE';
  // For the FIDE row, don't restrict country (it's international).
  const countryFilter = useNative ? null : fed.iso2;

  let results: SearchResult[] = [];
  let totalCount = 0;
  let searchError: string | null = null;

  // When FIDE-slice and federation has no iso2 (sub-countries with iso2='GB'),
  // we still query: multiple sub-federations share GB but the page header
  // makes it clear which one this is.
  if (useNative || countryFilter) {
    const res = await supabase.rpc('search_federation_players', {
      q: '',
      country_filter: countryFilter,
      rating_min: null,
      rating_max: null,
      federation_filter: federationFilter,
      title_filter: null,
      page_size: PAGE_SIZE,
      page_offset: offset,
    });
    if (res.error) {
      searchError = res.error.message;
    } else {
      results = (res.data ?? []) as SearchResult[];
      totalCount = results[0]?.total_count ?? 0;
    }
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const peers = feds
    .filter((f) => f.continent && f.continent === fed.continent && f.code !== fed.code)
    .slice(0, 8);

  // JSON-LD: Organization for the federation + ItemList of players
  const ldOrganization = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: fed.name,
    identifier: fed.code,
    address: fed.iso2
      ? {
          '@type': 'PostalAddress',
          addressCountry: fed.iso2,
        }
      : undefined,
    sameAs: fed.ratingListUrl ? [fed.ratingListUrl] : undefined,
  };
  const ldItemList = results.length > 0 && {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `${fed.name} top players`,
    numberOfItems: results.length,
    itemListElement: results.slice(0, 50).map((r, i) => ({
      '@type': 'ListItem',
      position: offset + i + 1,
      item: {
        '@type': 'Person',
        name: r.name,
        identifier: r.federation_player_id,
        nationality: r.country ?? undefined,
        award: r.title ?? undefined,
      },
    })),
  };

  return (
    <div className="min-h-screen">
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(ldOrganization) }}
      />
      {ldItemList && (
        <script
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: JSON.stringify(ldItemList) }}
        />
      )}

      <main className="container mx-auto max-w-5xl px-4 py-10">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">
          <Link href="/scout" className="hover:text-foreground">
            Scout
          </Link>{' '}
          / Federations
        </p>
        <div className="mt-2 flex items-baseline gap-3">
          <h1 className="font-display text-3xl font-bold tracking-tight md:text-4xl">{fed.name}</h1>
          <span className="rounded-md bg-muted/40 px-2 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {fed.code}
          </span>
        </div>
        <p className="mt-2 text-sm text-muted-foreground md:text-base">
          {fed.iso2 && <CountryFlag iso2={fed.iso2} />}{' '}
          {fed.continent && <span className="mr-2">{continentLabel(fed.continent)}</span>}
          {fed.estPlayerCount && (
            <span className="mr-2">≈{fed.estPlayerCount.toLocaleString()} players</span>
          )}
          {fed.ratingListUrl && (
            <a
              href={fed.ratingListUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-accent hover:underline"
            >
              Official list ↗
            </a>
          )}
        </p>

        <DataSourceBanner useNative={useNative} fed={fed} hasResults={results.length > 0} />

        <section className="mt-8">
          {searchError ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              Search failed: {searchError}
            </p>
          ) : results.length === 0 ? (
            <NoDataState fed={fed} />
          ) : (
            <>
              <div className="mb-4 flex items-center justify-between text-sm text-muted-foreground">
                <span>
                  <span className="text-foreground">{totalCount.toLocaleString()}</span>{' '}
                  {totalCount === 1 ? 'player' : 'players'}
                  {!useNative && ' (FIDE slice)'}
                </span>
                {totalPages > 1 && (
                  <span>
                    Page {page} of {totalPages}
                  </span>
                )}
              </div>

              <ul className="grid gap-3">
                {results.map((r) => (
                  <li key={r.id}>
                    <ResultCard result={r} />
                  </li>
                ))}
              </ul>

              {totalPages > 1 && <Pagination code={fed.code} page={page} totalPages={totalPages} />}
            </>
          )}
        </section>

        {peers.length > 0 && (
          <section className="mt-12 border-t border-border pt-8">
            <h2 className="text-xs font-semibold uppercase tracking-[0.3em] text-muted-foreground">
              Other {continentLabel(fed.continent)} federations
            </h2>
            <ul className="mt-3 flex flex-wrap gap-2">
              {peers.map((p) => (
                <li key={p.code}>
                  <Link
                    href={`/scout/federation/${p.code}`}
                    className="rounded-md border border-border/60 bg-card/40 px-3 py-1.5 text-sm hover:border-accent/40 hover:bg-card/80"
                  >
                    {p.code}: {p.name}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}

function DataSourceBanner({
  useNative,
  fed,
  hasResults,
}: {
  useNative: boolean;
  fed: { name: string; code: string; lastSyncedAt: string | null };
  hasResults: boolean;
}) {
  if (useNative) {
    return (
      <p className="mt-4 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
        <strong>Live data</strong>: {fed.name} official rating list
        {fed.lastSyncedAt ? `, synced ${new Date(fed.lastSyncedAt).toLocaleDateString()}` : ''}.
      </p>
    );
  }
  if (hasResults) {
    return (
      <p className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
        <strong>FIDE slice</strong>: players FIDE attributes to {fed.name}. {fed.name}&apos;s own
        rating list isn&apos;t integrated yet; we&apos;ll switch this page to native data when the
        parser ships.
      </p>
    );
  }
  return (
    <p className="mt-4 rounded-md border border-border/60 bg-card/40 px-3 py-2 text-xs text-muted-foreground">
      <strong>No data yet.</strong> {fed.name} is registered but no rated players appear in our
      corpus. We&apos;ll surface roster data once either the federation&apos;s parser ships or its
      members appear on the FIDE rating list.
    </p>
  );
}

function NoDataState({ fed }: { fed: { name: string; ratingListUrl: string | null } }) {
  return (
    <div className="rounded-lg border border-border bg-card/40 p-6 text-center">
      <p className="text-base font-medium">No players found.</p>
      <p className="mt-2 text-sm text-muted-foreground">
        {fed.ratingListUrl ? (
          <>
            Visit the{' '}
            <a
              href={fed.ratingListUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-accent hover:underline"
            >
              official {fed.name} list
            </a>{' '}
            in the meantime.
          </>
        ) : (
          <>We haven&apos;t found a public rating list for {fed.name} yet.</>
        )}
      </p>
    </div>
  );
}

function Pagination({
  code,
  page,
  totalPages,
}: {
  code: string;
  page: number;
  totalPages: number;
}) {
  const prev = page > 1 ? `/scout/federation/${code}?page=${page - 1}` : null;
  const next = page < totalPages ? `/scout/federation/${code}?page=${page + 1}` : null;
  return (
    <nav className="mt-6 flex items-center justify-between text-sm">
      {prev ? (
        <Link href={prev} className="text-accent hover:underline">
          ← Previous
        </Link>
      ) : (
        <span className="text-muted-foreground/60">← Previous</span>
      )}
      <span className="text-muted-foreground">
        Page {page} of {totalPages}
      </span>
      {next ? (
        <Link href={next} className="text-accent hover:underline">
          Next →
        </Link>
      ) : (
        <span className="text-muted-foreground/60">Next →</span>
      )}
    </nav>
  );
}

function CountryFlag({ iso2 }: { iso2: string }) {
  // Convert ISO alpha-2 to regional indicator emoji (e.g. 'IL' → 🇮🇱)
  const flag = iso2
    .toUpperCase()
    .split('')
    .map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 'A'.charCodeAt(0)))
    .join('');
  return <span className="mr-2">{flag}</span>;
}

function continentLabel(c: string | null): string {
  switch (c) {
    case 'EU':
      return 'European';
    case 'NA':
      return 'North American';
    case 'SA':
      return 'South American';
    case 'AS':
      return 'Asian';
    case 'AF':
      return 'African';
    case 'OC':
      return 'Oceanian';
    default:
      return '';
  }
}
