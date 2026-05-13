import Link from 'next/link';
import { notFound } from 'next/navigation';
import { brand } from '@chessco/ui';
import { getUser } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { ChesscoMark } from '@/lib/logo';
import { CountryBadge, TitleBadge } from '../../scout/result-card';

export const metadata = {
  title: 'Chessco profile',
};

// Matches the regex used at onboarding (apps/web/app/onboarding/onboarding-form.tsx).
const USERNAME_RE = /^[a-z0-9_-]{3,30}$/;

interface RouteProps {
  params: Promise<{ username: string }>;
}

type ExternalAccountRow = {
  platform: 'lichess' | 'chess.com' | 'fide' | 'chess-results';
  external_id: string;
  rating_bullet: number | null;
  rating_blitz: number | null;
  rating_rapid: number | null;
  rating_classical: number | null;
};

type GameRow = {
  match_id: string;
  result: '1-0' | '0-1' | '1/2-1/2' | '*' | null;
  termination: string | null;
  white_user_id: string;
  black_user_id: string;
  time_control: string;
  completed_at: string | null;
  started_at: string;
};

export default async function PublicUserProfile({ params }: RouteProps) {
  const { username: rawUsername } = await params;
  const username = rawUsername.toLowerCase();
  if (!USERNAME_RE.test(username)) notFound();

  const supabase = await createClient();
  const viewer = await getUser();

  const { data: target } = await supabase
    .from('profiles')
    .select('id, username, display_name, country, chess_title, profile_visibility')
    .eq('username', username)
    .is('deleted_at', null)
    .maybeSingle();

  if (!target) notFound();

  const isSelf = viewer?.id === target.id;
  const isPublic = target.profile_visibility === 'public';
  const showFull = isSelf || isPublic;

  // Restricted view: a private profile renders a stub with just the username.
  if (!showFull) {
    return (
      <Shell viewerSignedIn={!!viewer}>
        <section className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">Profile</p>
          <h1 className="font-display text-4xl font-bold tracking-tight">@{target.username}</h1>
          <p className="text-sm text-muted-foreground">This profile is private.</p>
        </section>
      </Shell>
    );
  }

  // Full view: fetch linked accounts, completed games, rating snapshot in parallel.
  // Use the admin client so RLS on live_games (participant-only) doesn't hide
  // them from logged-out viewers or non-participants — same pattern as
  // /account/history/page.tsx.
  const admin = createAdminClient();
  const [linkedRes, gamesRes, ratingRes] = await Promise.all([
    admin
      .from('external_accounts')
      .select('platform, external_id, rating_bullet, rating_blitz, rating_rapid, rating_classical')
      .eq('profile_id', target.id)
      .eq('verified', true),
    admin
      .from('live_games')
      .select(
        'match_id, result, termination, white_user_id, black_user_id, time_control, completed_at, started_at',
      )
      .or(`white_user_id.eq.${target.id},black_user_id.eq.${target.id}`)
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(30),
    admin.from('ratings').select('skill_rating').eq('profile_id', target.id).maybeSingle(),
  ]);

  const linked = (linkedRes.data ?? []) as ExternalAccountRow[];
  const games = (gamesRes.data ?? []) as GameRow[];

  // Best-known rating across verified online accounts, fallback to Chessco skill.
  const onlineBest = linked.reduce<number | null>((best, row) => {
    const r =
      row.rating_rapid ?? row.rating_blitz ?? row.rating_classical ?? row.rating_bullet ?? null;
    if (r == null) return best;
    return best == null || r > best ? r : best;
  }, null);
  const skillFallback =
    ratingRes.data?.skill_rating != null ? Math.round(Number(ratingRes.data.skill_rating)) : null;
  const bestRating = onlineBest ?? skillFallback;

  // Opponent labels for the games list. Pull all opponents in one round-trip,
  // then render "Private user" when opponent's profile_visibility != public.
  const opponentIds = Array.from(
    new Set(games.map((g) => (g.white_user_id === target.id ? g.black_user_id : g.white_user_id))),
  );
  const opponentsById = new Map<
    string,
    { display_name: string | null; username: string | null; profile_visibility: string }
  >();
  if (opponentIds.length > 0) {
    const { data: opps } = await admin
      .from('profiles')
      .select('id, display_name, username, profile_visibility')
      .in('id', opponentIds);
    for (const o of opps ?? []) opponentsById.set(o.id, o);
  }

  return (
    <Shell viewerSignedIn={!!viewer}>
      {isSelf && !isPublic && (
        <div className="mb-6 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-700">
          Your profile is private — others see only your username.{' '}
          <Link href="/account/privacy" className="underline">
            Change privacy
          </Link>
        </div>
      )}

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          {target.chess_title && <TitleBadge title={target.chess_title} />}
          {target.country && <CountryBadge code={target.country} />}
        </div>
        <h1 className="font-display text-4xl font-bold tracking-tight">
          {target.display_name ?? `@${target.username}`}
        </h1>
        <p className="text-sm text-muted-foreground">@{target.username}</p>
      </section>

      {bestRating != null && (
        <section className="mt-8">
          <div className="inline-block rounded-lg border border-border bg-card p-5">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Best-known rating
            </p>
            <p className="mt-1 font-display text-3xl font-bold tabular-nums">{bestRating}</p>
          </div>
        </section>
      )}

      {linked.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Linked online accounts
          </h2>
          <ul className="mt-3 space-y-2">
            {linked.map((a) => (
              <li
                key={`${a.platform}-${a.external_id}`}
                className="flex items-center justify-between rounded-md border border-emerald-500/30 bg-emerald-500/5 px-4 py-3"
              >
                <div>
                  {a.platform === 'lichess' || a.platform === 'chess.com' ? (
                    <a
                      href={
                        a.platform === 'lichess'
                          ? `https://lichess.org/@/${a.external_id}`
                          : `https://www.chess.com/member/${a.external_id}`
                      }
                      target="_blank"
                      rel="noreferrer noopener"
                      className="font-display font-semibold tracking-tight hover:text-accent"
                    >
                      {a.external_id}
                    </a>
                  ) : (
                    <span className="font-display font-semibold tracking-tight">
                      {a.external_id}
                    </span>
                  )}
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {a.platform}
                  </p>
                </div>
                <span className="text-xs font-medium uppercase tracking-wider text-emerald-500">
                  Verified
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-10">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Practice games{' '}
          {games.length > 0 && <span className="text-foreground">({games.length})</span>}
        </h2>
        {games.length === 0 ? (
          <p className="mt-3 rounded-md border border-border bg-card/50 p-4 text-sm text-muted-foreground">
            No completed games yet.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {games.map((g) => {
              const youAreWhite = g.white_user_id === target.id;
              const oppId = youAreWhite ? g.black_user_id : g.white_user_id;
              const opp = opponentsById.get(oppId);
              const oppLabel =
                !opp || opp.profile_visibility !== 'public'
                  ? 'Private user'
                  : (opp.display_name ?? (opp.username ? `@${opp.username}` : 'Player'));
              const oppLink =
                opp && opp.profile_visibility === 'public' && opp.username
                  ? `/u/${opp.username}`
                  : null;
              return (
                <li
                  key={g.match_id}
                  className="rounded-md border border-border bg-card px-4 py-3 text-sm"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <Link
                        href={`/practice/g/${g.match_id}/review`}
                        className="font-medium hover:text-accent hover:underline"
                      >
                        {g.result ?? '—'} as {youAreWhite ? 'white' : 'black'}
                      </Link>
                      <p className="text-[11px] text-muted-foreground">
                        vs{' '}
                        {oppLink ? (
                          <Link href={oppLink} className="hover:text-accent hover:underline">
                            {oppLabel}
                          </Link>
                        ) : (
                          oppLabel
                        )}{' '}
                        · {g.time_control}
                        {g.termination ? ` · ${g.termination}` : ''}
                      </p>
                    </div>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {fmtDate(g.completed_at ?? g.started_at)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </Shell>
  );
}

function Shell({
  children,
  viewerSignedIn,
}: {
  children: React.ReactNode;
  viewerSignedIn: boolean;
}) {
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
            {viewerSignedIn ? (
              <Link href="/dashboard" className="text-muted-foreground hover:text-foreground">
                Dashboard
              </Link>
            ) : (
              <Link
                href="/signup"
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground hover:opacity-90"
              >
                Get started
              </Link>
            )}
          </nav>
        </div>
      </header>
      <main className="container mx-auto max-w-4xl px-4 py-10">{children}</main>
    </div>
  );
}

function fmtDate(s: string | null): string {
  if (!s) return '';
  try {
    return new Date(s).toLocaleDateString();
  } catch {
    return s;
  }
}
