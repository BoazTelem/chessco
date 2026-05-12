import Link from 'next/link';
import { brand } from '@chessco/ui';
import { getUser } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { ChesscoMark } from '@/lib/logo';
import { SearchForm } from './search-form';
import { HandleResultCard, ResultCard, type HandleResult } from './result-card';
import { TrackPersonCTA } from './track-person-cta';
import { normalizeCountry } from '@/lib/scout/country-code';
import { searchLichessHandlesByName } from '@/lib/scout/lichess-handles';
import type { SearchResult } from './types';

export const metadata = {
  title: 'Scout — find a player',
  description: 'Search 755k+ FIDE-rated chess players by name, country, and rating.',
};

const PAGE_SIZE = 20;

type SearchParams = {
  q?: string;
  country?: string;
  title?: string;
  min?: string;
  max?: string;
  page?: string;
};

export default async function ScoutPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const user = await getUser();
  const supabase = await createClient();

  const q = (params.q ?? '').trim();
  const country = params.country?.trim() || null;
  const title = params.title?.trim() || null;
  const min = params.min ? parseInt(params.min, 10) : null;
  const max = params.max ? parseInt(params.max, 10) : null;
  const page = Math.max(1, parseInt(params.page ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const hasQuery = q.length > 0 || country || title || min !== null || max !== null;

  let results: SearchResult[] = [];
  let handleResults: HandleResult[] = [];
  let totalCount = 0;
  let searchError: string | null = null;

  if (hasQuery) {
    // Three parallel searches:
    //   1. FIDE federation rows (Supabase)
    //   2. chess.com handles by claimed_name (Supabase platform_players)
    //   3. Lichess handles by fuzzy handle text (Cloud SQL games-corpus)
    // All three results render as grouped sections; chess.com + Lichess
    // share the HandleResultCard component because the result shape is
    // identical (modulo platform-specific URL formatting).
    const handleCountry = country ? normalizeCountry(country) : null;
    const [fideRes, handleRes, lichessHandles] = await Promise.all([
      supabase.rpc('search_federation_players', {
        q,
        country_filter: country,
        rating_min: Number.isFinite(min) ? min : null,
        rating_max: Number.isFinite(max) ? max : null,
        federation_filter: null,
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
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const nextQs = new URLSearchParams();
  if (q) nextQs.set('q', q);
  if (country) nextQs.set('country', country);
  if (title) nextQs.set('title', title);
  if (min !== null && Number.isFinite(min)) nextQs.set('min', String(min));
  if (max !== null && Number.isFinite(max)) nextQs.set('max', String(max));
  if (page > 1) nextQs.set('page', String(page));
  const nextPath = nextQs.toString() ? `/scout?${nextQs.toString()}` : '/scout';

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-card/50">
        <div className="container mx-auto flex items-center justify-between px-4 py-4">
          <Link
            href="/"
            aria-label={brand.name}
            className="inline-flex items-center gap-2 hover:opacity-80"
          >
            <ChesscoMark className="h-4 w-4 shrink-0" />
            <span className="font-display font-semibold uppercase tracking-[0.3em] text-accent">
              {brand.name}
            </span>
          </Link>
          <nav className="flex items-center gap-3 text-sm">
            {user ? (
              <>
                <Link href="/dashboard" className="text-muted-foreground hover:text-foreground">
                  Dashboard
                </Link>
                <Link href="/account" className="text-muted-foreground hover:text-foreground">
                  Account
                </Link>
              </>
            ) : (
              <>
                <Link href="/login" className="text-muted-foreground hover:text-foreground">
                  Sign in
                </Link>
                <Link
                  href="/signup"
                  className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground hover:opacity-90"
                >
                  Get started
                </Link>
              </>
            )}
          </nav>
        </div>
      </header>

      <main className="container mx-auto max-w-5xl px-4 py-10">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">Scout</p>
          <h1 className="font-display text-3xl font-bold tracking-tight md:text-4xl">
            Find any chess player
          </h1>
          <p className="text-sm text-muted-foreground md:text-base">
            Search {(755_081).toLocaleString()} rated players from 200+ federations plus indexed
            Lichess and chess.com handles — amateurs are findable too. Open a profile to identify
            their other online accounts.
          </p>
        </div>

        <div className="mt-8">
          <SearchForm
            initial={{
              q,
              country: country ?? '',
              title: title ?? '',
              min: min?.toString() ?? '',
              max: max?.toString() ?? '',
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
          ) : results.length === 0 && handleResults.length === 0 ? (
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
                      params={{ q, country, title, min, max }}
                    />
                  )}
                </>
              )}

              {handleResults.length > 0 && (
                <div className={results.length > 0 ? 'mt-10' : ''}>
                  <div className="mb-4 flex items-center gap-3 text-sm text-muted-foreground">
                    <span className="text-foreground">{handleResults.length}</span>
                    <span>
                      online{' '}
                      {handleResults.length === 1 ? 'handle also matches' : 'handles also match'}
                    </span>
                    <span className="text-xs">(chess.com + Lichess — opens external profile)</span>
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

              {results.length === 0 && handleResults.length > 0 && (
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
        Start with a name (Carlsen, Nepomniachtchi), filter by country (NOR, USA, ISR), or set a
        rating range. Trigram fuzzy match — typos welcome.
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2 text-xs">
        <SampleQuery label="magnus carlsen" />
        <SampleQuery label="kasparov" />
        <SampleQuery label="GM ISR" query="" country="ISR" title="GM" />
        <SampleQuery label="2700+" query="" min="2700" />
      </div>
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
  };
}) {
  function pageHref(p: number): string {
    const sp = new URLSearchParams();
    if (params.q) sp.set('q', params.q);
    if (params.country) sp.set('country', params.country);
    if (params.title) sp.set('title', params.title);
    if (params.min !== null) sp.set('min', String(params.min));
    if (params.max !== null) sp.set('max', String(params.max));
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
