import Link from 'next/link';
import { brand } from '@chessco/ui';
import { getUser } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { ChesscoMark } from '@/lib/logo';
import { SearchForm } from './search-form';
import { ResultCard } from './result-card';
import { SampleGameForm } from './sample-game-form';
import type { SearchResult } from './types';

export const metadata = {
  title: 'Scout — find a player',
  description: 'Search 755k+ FIDE-rated chess players by name, country, and rating.',
};

const PAGE_SIZE = 20;

type SearchParams = {
  q?: string;
  country?: string;
  fed?: string;
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
  const fed = params.fed?.trim() || null;
  const title = params.title?.trim() || null;
  const min = params.min ? parseInt(params.min, 10) : null;
  const max = params.max ? parseInt(params.max, 10) : null;
  const page = Math.max(1, parseInt(params.page ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const hasQuery = q.length > 0 || country || fed || title || min !== null || max !== null;

  let results: SearchResult[] = [];
  let totalCount = 0;
  let searchError: string | null = null;

  if (hasQuery) {
    const { data, error } = await supabase.rpc('search_federation_players', {
      q,
      country_filter: country,
      rating_min: Number.isFinite(min) ? min : null,
      rating_max: Number.isFinite(max) ? max : null,
      federation_filter: fed,
      title_filter: title,
      page_size: PAGE_SIZE,
      page_offset: offset,
    });

    if (error) {
      searchError = error.message;
    } else {
      results = (data ?? []) as SearchResult[];
      totalCount = results[0]?.total_count ?? 0;
    }
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

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
            Identify the Lichess / chess.com accounts of any player worldwide. Works on titled
            players, amateurs, and anyone in between — no FIDE rating required.
          </p>
        </div>

        {/* PRIMARY: AI sample-game matching — works for every player, FIDE or not. */}
        <section className="mt-8 rounded-lg border border-accent/40 bg-accent/5 p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-display text-lg font-semibold">Paste their games — AI matching</h2>
            <span className="text-[10px] uppercase tracking-[0.2em] text-accent">
              For any player
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Have 10+ games of any chess player? AI identifies their Lichess + chess.com accounts by
            play pattern (opening repertoire, time class, opponent rating). Works whether
            they&apos;re titled, FIDE-rated, or completely unrated.
          </p>
          <div className="mt-4 max-w-2xl">
            <SampleGameForm />
          </div>
        </section>

        {/* SECONDARY: structured FIDE search — for users who already know the player. */}
        <section className="mt-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-display text-lg font-semibold">Or search by name</h2>
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              FIDE database · {(755_081).toLocaleString()} players
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Already know who they are? Search the FIDE rating list directly. Drill into a profile to
            run AI matching anchored to their name.
          </p>
          <div className="mt-4">
            <SearchForm
              initial={{
                q,
                country: country ?? '',
                fed: fed ?? '',
                title: title ?? '',
                min: min?.toString() ?? '',
                max: max?.toString() ?? '',
              }}
            />
          </div>
        </section>

        <section className="mt-10">
          {!hasQuery ? (
            <EmptyState />
          ) : searchError ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              Search failed: {searchError}
            </p>
          ) : results.length === 0 ? (
            <NoResults q={q} />
          ) : (
            <>
              <div className="mb-4 flex items-center justify-between text-sm text-muted-foreground">
                <span>
                  <span className="text-foreground">{totalCount.toLocaleString()}</span>{' '}
                  {totalCount === 1 ? 'result' : 'results'}
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
                  params={{ q, country, fed, title, min, max }}
                />
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

function NoResults({ q }: { q: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-8 text-center">
      <p className="text-sm">
        No players match <span className="font-medium">&ldquo;{q}&rdquo;</span>.
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        Try a shorter query, a different country code, or remove the rating range.
      </p>
    </div>
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
    fed: string | null;
    title: string | null;
    min: number | null;
    max: number | null;
  };
}) {
  function pageHref(p: number): string {
    const sp = new URLSearchParams();
    if (params.q) sp.set('q', params.q);
    if (params.country) sp.set('country', params.country);
    if (params.fed) sp.set('fed', params.fed);
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
