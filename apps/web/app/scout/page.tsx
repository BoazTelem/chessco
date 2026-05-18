import Link from 'next/link';
import { getUser } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { SearchForm } from './search-form';
import {
  AdHocResultCard,
  HandleResultCard,
  ResultCard,
  type AdHocResult,
  type HandleResult,
} from './result-card';
import { TrackPersonCTA } from './track-person-cta';
import { normalizeCountry } from '@/lib/scout/country-code';
import { searchLichessHandlesByName } from '@/lib/scout/lichess-handles';
import { getIndexStats } from '@/lib/index-stats';
import { getFederations } from '@/lib/scout/federations';
import { logSearchEvent } from '@/lib/search-events/log';
import type { SearchResult } from './types';

export const metadata = {
  title: 'Scout: find a player',
  description:
    'Search FIDE, USCF, and Israeli Chess Federation players by name, country, and rating.',
};

const PAGE_SIZE = 20;

type SearchParams = {
  q?: string;
  country?: string;
  title?: string;
  min?: string;
  max?: string;
  page?: string;
  federation?: string;
};

// No page-level `revalidate`: getUser() reads cookies, and mixing
// `cookies()` with `revalidate` was causing returning logged-in users
// to see logged-out UI. The indexed-player count is cached hourly
// inside getIndexStats() (unstable_cache) instead.

export default async function ScoutPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const [user, supabase, stats, federations] = await Promise.all([
    getUser(),
    createClient(),
    getIndexStats(),
    getFederations(),
  ]);

  const q = (params.q ?? '').trim();
  const country = params.country?.trim() || null;
  const title = params.title?.trim() || null;
  const min = params.min ? parseInt(params.min, 10) : null;
  const max = params.max ? parseInt(params.max, 10) : null;
  const federationRaw = params.federation?.trim().toUpperCase() || '';
  // Validate against the DB-loaded list (post-2026-05-14 expansion: 207 codes).
  // Search engine still only returns useful results for `active=true` federations,
  // but accepting any valid code lets the UI surface FIDE-slice results for the rest
  // via the country filter on `search_federation_players`.
  const federation = federations.some((f) => f.code === federationRaw) ? federationRaw : null;
  const page = Math.max(1, parseInt(params.page ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const hasQuery =
    q.length > 0 || country || title || min !== null || max !== null || federation !== null;

  let results: SearchResult[] = [];
  let handleResults: HandleResult[] = [];
  let adHocResults: AdHocResult[] = [];
  let totalCount = 0;
  let searchError: string | null = null;

  if (hasQuery) {
    // Four parallel searches:
    //   1. FIDE federation rows (Supabase)
    //   2. chess.com handles by claimed_name (Supabase platform_players)
    //   3. Lichess handles by fuzzy handle text (Cloud SQL games-corpus)
    //   4. Community-verified ad-hoc players (Supabase ad_hoc_players +
    //      ad_hoc_player_handles; only rows the promote-ad-hoc nightly
    //      worker has marked promotion_status='promoted'). RPC handles
    //      the trigram + handle-aggregation that postgrest can't express.
    // All four results render as grouped sections; chess.com + Lichess
    // share the HandleResultCard component because the result shape is
    // identical (modulo platform-specific URL formatting).
    const handleCountry = country ? normalizeCountry(country) : null;
    const [fideRes, handleRes, lichessHandles, adHocRes] = await Promise.all([
      supabase.rpc('search_federation_players', {
        q,
        country_filter: country,
        rating_min: Number.isFinite(min) ? min : null,
        rating_max: Number.isFinite(max) ? max : null,
        federation_filter: federation,
        title_filter: title,
        page_size: PAGE_SIZE,
        page_offset: offset,
      }),
      q.length >= 2
        ? supabase.rpc('search_platform_players_by_name', {
            q: q.toLowerCase(),
            country_filter: handleCountry,
            limit_count: 15,
            min_similarity: 0.4,
          })
        : Promise.resolve({ data: [], error: null }),
      q.length >= 2
        ? searchLichessHandlesByName(q.toLowerCase(), 10, 0.3).catch(() => [])
        : Promise.resolve([] as HandleResult[]),
      q.length >= 2
        ? supabase.rpc('search_promoted_ad_hoc', {
            q,
            country_filter: country,
            limit_count: 10,
            min_similarity: 0.3,
          })
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (fideRes.error) {
      searchError = fideRes.error.message;
    } else {
      results = (fideRes.data ?? []) as SearchResult[];
      totalCount = results[0]?.total_count ?? 0;
    }
    if (!handleRes.error && handleRes.data) {
      handleResults = handleRes.data as HandleResult[];
    }
    // Append Lichess handles to the combined handle list. Dedupe is not
    // needed today (chess.com and Lichess can't collide), but if we ever
    // merge they would by (platform, handle).
    if (lichessHandles.length > 0) {
      handleResults = [...handleResults, ...lichessHandles];
    }
    // Community-verified ad-hoc rows. Soft-fail on RPC error so a missing
    // migration doesn't break the main scout flow: log and continue.
    if (adHocRes.error) {
      console.warn(`[scout] search_promoted_ad_hoc failed: ${adHocRes.error.message}`);
    } else if (adHocRes.data) {
      adHocResults = adHocRes.data as AdHocResult[];
    }

    void logSearchEvent({
      kind: 'scout_query',
      profileId: user?.id ?? null,
      queryText: q || null,
      resultCount: results.length + handleResults.length + adHocResults.length,
      extra: {
        country,
        title,
        min,
        max,
        federation,
        page,
        fide_total: totalCount,
        ad_hoc_total: adHocResults.length,
      },
    });
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const nextQs = new URLSearchParams();
  if (q) nextQs.set('q', q);
  if (country) nextQs.set('country', country);
  if (title) nextQs.set('title', title);
  if (min !== null && Number.isFinite(min)) nextQs.set('min', String(min));
  if (max !== null && Number.isFinite(max)) nextQs.set('max', String(max));
  if (federation) nextQs.set('federation', federation);
  if (page > 1) nextQs.set('page', String(page));
  const nextPath = nextQs.toString() ? `/scout?${nextQs.toString()}` : '/scout';

  return (
    <div className="min-h-screen">
      <main className="container mx-auto max-w-5xl px-4 py-10">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">Scout</p>
          <h1 className="font-display text-3xl font-bold tracking-tight md:text-4xl">
            Find any chess player
          </h1>
          <p className="text-sm text-muted-foreground md:text-base">
            {(stats.fide + stats.uscf + stats.icf).toLocaleString()} indexed players, plus Lichess
            and chess.com handles. Open a profile to identify their other online accounts.
          </p>
        </div>

        <div className="mt-8">
          <SearchForm
            federations={federations}
            initial={{
              q,
              country: country ?? '',
              title: title ?? '',
              min: min?.toString() ?? '',
              max: max?.toString() ?? '',
              federation: federation ?? '',
            }}
          />
        </div>

        <section className="mt-10">
          {!hasQuery ? (
            <EmptyState />
          ) : searchError ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              Search failed: {searchError}
            </p>
          ) : results.length === 0 && handleResults.length === 0 && adHocResults.length === 0 ? (
            <TrackPersonCTA name={q} country={country} signedIn={!!user} nextPath={nextPath} />
          ) : (
            <>
              {results.length > 0 && (
                <>
                  <div className="mb-4 flex items-center justify-between text-sm text-muted-foreground">
                    <span>
                      <span className="text-foreground">{totalCount.toLocaleString()}</span> FIDE /
                      federation {totalCount === 1 ? 'result' : 'results'}
                      {q && (
                        <>
                          {' for '}
                          <span className="text-foreground">&ldquo;{q}&rdquo;</span>
                        </>
                      )}
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

                  {totalPages > 1 && (
                    <Pagination
                      page={page}
                      totalPages={totalPages}
                      params={{ q, country, title, min, max, federation }}
                    />
                  )}
                </>
              )}

              {adHocResults.length > 0 && (
                <div className={results.length > 0 ? 'mt-10' : ''}>
                  <div className="mb-4 flex items-center gap-3 text-sm text-muted-foreground">
                    <span className="text-foreground">{adHocResults.length}</span>
                    <span>
                      community-verified {adHocResults.length === 1 ? 'player' : 'players'}
                    </span>
                    <span className="text-xs">
                      (tracked by signed-in users when FIDE doesn&apos;t have them, links to the
                      ad-hoc profile)
                    </span>
                  </div>
                  <ul className="grid gap-3">
                    {adHocResults.map((a) => (
                      <li key={a.id}>
                        <AdHocResultCard result={a} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {handleResults.length > 0 && (
                <div className={results.length > 0 || adHocResults.length > 0 ? 'mt-10' : ''}>
                  <div className="mb-4 flex items-center gap-3 text-sm text-muted-foreground">
                    <span className="text-foreground">{handleResults.length}</span>
                    <span>
                      online{' '}
                      {handleResults.length === 1 ? 'handle also matches' : 'handles also match'}
                    </span>
                    <span className="text-xs">(chess.com + Lichess, opens external profile)</span>
                  </div>
                  <ul className="grid gap-3">
                    {handleResults.map((h) => (
                      <li key={`${h.platform}:${h.handle}`}>
                        <HandleResultCard result={h} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {results.length === 0 && (handleResults.length > 0 || adHocResults.length > 0) && (
                <div className="mt-8">
                  <TrackPersonCTA
                    name={q}
                    country={country}
                    signedIn={!!user}
                    nextPath={nextPath}
                  />
                </div>
              )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-border bg-card p-8 text-center">
      <p className="text-sm text-muted-foreground">
        Try a name, country code (NOR, USA, ISR), or rating range. Fuzzy match handles typos.
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2 text-xs">
        <SampleQuery label="magnus carlsen" />
        <SampleQuery label="kasparov" />
        <SampleQuery label="GM ISR" query="" country="ISR" title="GM" />
        <SampleQuery label="GM USA" query="" country="USA" title="GM" />
        <SampleQuery label="2700+" query="" min="2700" />
      </div>
      <p className="mt-6 text-xs text-muted-foreground">
        No luck by name? Open any candidate and the page exposes a <em>paste their games</em>{' '}
        refiner.{' '}
        <Link href="/benchmarks#path-b" className="underline hover:text-foreground">
          see how accurate that is
        </Link>
        .
      </p>
    </div>
  );
}

function SampleQuery({
  label,
  query,
  country,
  title,
  min,
}: {
  label: string;
  query?: string;
  country?: string;
  title?: string;
  min?: string;
}) {
  const params = new URLSearchParams();
  if (query !== undefined) params.set('q', query);
  else params.set('q', label);
  if (country) params.set('country', country);
  if (title) params.set('title', title);
  if (min) params.set('min', min);

  return (
    <Link
      href={`/scout?${params.toString()}`}
      className="rounded-full border border-border bg-background px-3 py-1 hover:border-accent hover:text-accent"
    >
      {label}
    </Link>
  );
}

function Pagination({
  page,
  totalPages,
  params,
}: {
  page: number;
  totalPages: number;
  params: {
    q: string;
    country: string | null;
    title: string | null;
    min: number | null;
    max: number | null;
    federation: string | null;
  };
}) {
  function pageHref(p: number): string {
    const sp = new URLSearchParams();
    if (params.q) sp.set('q', params.q);
    if (params.country) sp.set('country', params.country);
    if (params.title) sp.set('title', params.title);
    if (params.min !== null) sp.set('min', String(params.min));
    if (params.max !== null) sp.set('max', String(params.max));
    if (params.federation) sp.set('federation', params.federation);
    if (p > 1) sp.set('page', String(p));
    return `/scout?${sp.toString()}`;
  }

  return (
    <div className="mt-6 flex items-center justify-between text-sm">
      {page > 1 ? (
        <Link
          href={pageHref(page - 1)}
          className="rounded-md border border-border bg-card px-3 py-1.5 hover:bg-muted"
        >
          ← Previous
        </Link>
      ) : (
        <span className="rounded-md border border-border bg-card/50 px-3 py-1.5 text-muted-foreground">
          ← Previous
        </span>
      )}
      <span className="text-muted-foreground">
        Page {page} of {totalPages}
      </span>
      {page < totalPages ? (
        <Link
          href={pageHref(page + 1)}
          className="rounded-md border border-border bg-card px-3 py-1.5 hover:bg-muted"
        >
          Next →
        </Link>
      ) : (
        <span className="rounded-md border border-border bg-card/50 px-3 py-1.5 text-muted-foreground">
          Next →
        </span>
      )}
    </div>
  );
}
