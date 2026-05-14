import Link from 'next/link';
import { brand } from '@chessco/ui';
import { getUser } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { ChesscoMark } from '@/lib/logo';
import { LobbyCard, type LobbyChallenge } from '@/components/practice/LobbyCard';
import { LobbyLiveUpdates } from '@/components/practice/LobbyLiveUpdates';
import { SegmentedLinks } from '@/components/ui/SegmentedControl';

export const metadata = {
  title: 'Practice — paid play from any position',
  description:
    'Browse positions chess players are paying to practice. Accept a challenge and earn for playing the game.',
};

// No page-level `revalidate`: getUser() reads cookies, mixing with revalidate
// would cause logged-in users to render as logged-out.

type SearchParams = {
  time_class?: string;
  min_fee?: string;
  opening?: string;
};

const ALLOWED_CLASSES = new Set(['bullet', 'blitz', 'rapid', 'classical']);

export default async function PracticeLobbyPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const timeClassFilter = ALLOWED_CLASSES.has(params.time_class ?? '') ? params.time_class! : null;
  const minFeeCents = params.min_fee ? Math.max(0, Math.floor(Number(params.min_fee) * 100)) : null;
  const openingFilter = params.opening?.trim() || null;

  const user = await getUser();
  const supabase = await createClient();

  // Main query for the visible cards. Stale-heartbeat rows are hidden so
  // accepters never end up stranded waiting for an offline creator.
  // Heartbeat interval is 20s; a 25s cutoff hides any creator whose ping has
  // missed even a single beat, shrinking the "accept a ghost challenge" window.
  const liveCutoff = new Date(Date.now() - 25_000).toISOString();
  let query = supabase
    .from('challenges')
    .select(
      'id, creator_id, fen, creator_color, time_control, time_class, fee_cents, funding_type, credit_cost, rating_min, rating_max, games_requested, games_completed, notes, opening_name, anonymous, creator_rating, created_at, profiles:profiles!challenges_creator_id_fkey(display_name, username, profile_visibility)',
    )
    .eq('status', 'open')
    .is('target_opponent_id', null) // direct invites are private to the invitee
    .gt('last_heartbeat', liveCutoff)
    .order('created_at', { ascending: false })
    .limit(60);

  if (timeClassFilter) query = query.eq('time_class', timeClassFilter);
  if (minFeeCents !== null) query = query.gte('fee_cents', minFeeCents);
  if (openingFilter) query = query.eq('opening_name', openingFilter);

  // Second query: distinct opening names across all open challenges for the
  // filter dropdown. Cheap because of challenges_opening_open_idx.
  const [{ data: rawChallenges, error }, { data: openingsRows }] = await Promise.all([
    query,
    supabase
      .from('challenges')
      .select('opening_name')
      .eq('status', 'open')
      .is('target_opponent_id', null)
      .gt('last_heartbeat', liveCutoff)
      .not('opening_name', 'is', null)
      .order('opening_name', { ascending: true }),
  ]);

  type RawProfile = {
    display_name: string | null;
    username: string | null;
    profile_visibility: 'public' | 'private' | 'coach_public_player_private';
  };
  type Raw = Omit<
    LobbyChallenge,
    'creator_display_name' | 'creator_username' | 'creator_visibility'
  > & {
    profiles: RawProfile | RawProfile[] | null;
  };

  const challenges: LobbyChallenge[] = ((rawChallenges as Raw[] | null) ?? []).map((c) => {
    const p = Array.isArray(c.profiles) ? c.profiles[0] : c.profiles;
    return {
      ...c,
      creator_display_name: p?.display_name ?? null,
      creator_username: p?.username ?? null,
      creator_visibility: p?.profile_visibility ?? 'public',
    };
  });

  const openOpenings = Array.from(
    new Set(
      ((openingsRows as Array<{ opening_name: string | null }> | null) ?? [])
        .map((r) => r.opening_name)
        .filter((s): s is string => !!s),
    ),
  );

  function filterHref(overrides: Partial<SearchParams>): string {
    const sp = new URLSearchParams();
    const merged: SearchParams = {
      time_class: timeClassFilter ?? undefined,
      opening: openingFilter ?? undefined,
      ...overrides,
    };
    if (merged.time_class) sp.set('time_class', merged.time_class);
    if (merged.opening) sp.set('opening', merged.opening);
    const q = sp.toString();
    return q ? `/practice?${q}` : '/practice';
  }

  return (
    <div className="min-h-screen">
      <LobbyLiveUpdates />
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
              <Link href="/dashboard" className="text-muted-foreground hover:text-foreground">
                Dashboard
              </Link>
            ) : (
              <Link
                href="/signup"
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground"
              >
                Get started
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main className="container mx-auto max-w-4xl px-4 py-10">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">Practice</p>
          <h1 className="font-display text-3xl font-bold tracking-tight md:text-4xl">
            Get paid to play a position
          </h1>
          <p className="text-sm text-muted-foreground md:text-base">
            A player wants to drill a specific position. You accept, you play — and you keep the fee
            whatever the result.
          </p>
        </div>

        {/* Always-visible Create CTA — coaches and serial publishers should be
            one click away from publishing another position regardless of how
            many already-open challenges they have in the lobby. */}
        {user && (
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent/30 bg-accent/5 px-4 py-3">
            <p className="text-sm text-foreground">
              Have a position to drill?{' '}
              <span className="text-muted-foreground">Publish it and pick your opponent.</span>
            </p>
            <Link
              href="/practice/create"
              className="rounded-md bg-accent px-4 py-1.5 text-xs font-semibold text-accent-foreground"
            >
              Create a position →
            </Link>
          </div>
        )}

        <div className="mt-6">
          <SegmentedLinks
            options={[
              { value: 'all', label: 'All', href: filterHref({ time_class: undefined }) },
              ...(['bullet', 'blitz', 'rapid', 'classical'] as const).map((tc) => ({
                value: tc,
                label: tc[0]!.toUpperCase() + tc.slice(1),
                href: filterHref({ time_class: tc }),
              })),
            ]}
            value={timeClassFilter ?? 'all'}
            ariaLabel="Time class filter"
          />
        </div>

        {openOpenings.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Opening
            </span>
            <FilterChip
              label="Any"
              href={filterHref({ opening: undefined })}
              active={!openingFilter}
            />
            {openOpenings.map((op) => (
              <FilterChip
                key={op}
                label={op}
                href={filterHref({ opening: op })}
                active={openingFilter === op}
              />
            ))}
          </div>
        )}

        <section className="mt-8 space-y-3">
          {error ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              Failed to load lobby: {error.message}
            </p>
          ) : challenges.length === 0 ? (
            <EmptyState signedIn={!!user} filtered={!!(timeClassFilter || openingFilter)} />
          ) : (
            challenges.map((c) => (
              <LobbyCard
                key={c.id}
                challenge={c}
                isOwn={user?.id === c.creator_id}
                signedIn={!!user}
              />
            ))
          )}
        </section>
      </main>
    </div>
  );
}

function FilterChip({ label, href, active }: { label: string; href: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`rounded-full border px-3 py-1 text-xs ${
        active
          ? 'border-accent bg-accent text-accent-foreground'
          : 'border-border bg-background hover:bg-muted'
      }`}
    >
      {label}
    </Link>
  );
}

function EmptyState({ signedIn, filtered }: { signedIn: boolean; filtered: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-card p-10 text-center">
      <p className="text-sm text-muted-foreground">
        {filtered ? 'No challenges match those filters.' : 'No open challenges right now.'}
        {signedIn ? (
          <>
            {' '}
            <Link href="/practice/create" className="text-accent hover:underline">
              Create one
            </Link>
            .
          </>
        ) : (
          <>
            {' '}
            <Link href="/signup" className="text-accent hover:underline">
              Sign up
            </Link>{' '}
            to publish your own position.
          </>
        )}
      </p>
    </div>
  );
}
