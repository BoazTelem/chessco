import Link from 'next/link';
import { requireUser } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { signOut } from '../(auth)/actions';
import { LichessLinkButton } from './lichess-link-button';
import { ChesscomLinkForm } from './chesscom-link-form';
import { UnlinkButton } from './unlink-button';

export const metadata = {
  title: 'Account',
};

type ExternalAccount = {
  id: string;
  platform: 'lichess' | 'chess.com' | 'fide' | 'chess-results';
  external_id: string;
  external_url: string | null;
  verified: boolean;
  rating_bullet: number | null;
  rating_blitz: number | null;
  rating_rapid: number | null;
  rating_classical: number | null;
  last_synced_at: string | null;
};

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{
    linked?: string;
    handle?: string;
    lichess_error?: string;
    chesscom_error?: string;
  }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const supabase = await createClient();

  const { data: profile } = await supabase
    .from('profiles')
    .select('username, display_name, country, chess_title')
    .eq('id', user.id)
    .maybeSingle();

  const { data: accounts } = await supabase
    .from('external_accounts')
    .select(
      'id, platform, external_id, external_url, verified, rating_bullet, rating_blitz, rating_rapid, rating_classical, last_synced_at',
    )
    .eq('profile_id', user.id)
    .order('created_at', { ascending: true });

  const linked: ExternalAccount[] = (accounts ?? []) as ExternalAccount[];
  const lichessLinked = linked.find((a) => a.platform === 'lichess');
  const chesscomLinked = linked.find((a) => a.platform === 'chess.com');

  return (
    <div className="container mx-auto max-w-3xl space-y-10 px-4 py-12">
      <header className="flex items-start justify-between gap-6">
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">Account</p>
          <h1 className="font-display text-3xl font-bold tracking-tight">
            {profile?.display_name ?? profile?.username ?? user.email}
          </h1>
          <p className="text-sm text-muted-foreground">
            {profile?.username && <>@{profile.username} · </>}
            <span className="text-foreground">{user.email}</span>
            {profile?.country && (
              <>
                {' '}
                · <span className="text-foreground">{profile.country}</span>
              </>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/account/edit"
            className="rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted"
          >
            Edit profile
          </Link>
          <Link
            href="/account/privacy"
            className="rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted"
          >
            Privacy
          </Link>
          <Link
            href="/account/notifications"
            className="rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted"
          >
            Notifications
          </Link>
          <Link
            href="/dashboard"
            className="rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted"
          >
            Dashboard
          </Link>
          <form action={signOut}>
            <button
              type="submit"
              className="rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <FlashMessages
        linked={params.linked}
        handle={params.handle}
        lichessError={params.lichess_error}
        chesscomError={params.chesscom_error}
      />

      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Linked chess accounts
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            We import your games from these accounts to power prep reports and rating priors. Both
            accounts read-only. We never make moves or post on your behalf.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <PlatformCard title="Lichess" subtitle="OAuth, instant verification">
            {lichessLinked ? <LinkedSummary account={lichessLinked} /> : <LichessLinkButton />}
          </PlatformCard>

          <PlatformCard title="Chess.com" subtitle="Paste a token in your profile">
            {chesscomLinked ? <LinkedSummary account={chesscomLinked} /> : <ChesscomLinkForm />}
          </PlatformCard>
        </div>
      </section>
    </div>
  );
}

function PlatformCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-baseline justify-between">
        <h3 className="font-medium">{title}</h3>
        <span className="text-xs text-muted-foreground">{subtitle}</span>
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function LinkedSummary({ account }: { account: ExternalAccount }) {
  const ratings: Array<[string, number | null]> = [
    ['Bullet', account.rating_bullet],
    ['Blitz', account.rating_blitz],
    ['Rapid', account.rating_rapid],
    ['Classical', account.rating_classical],
  ];
  const hasRatings = ratings.some(([, r]) => r != null);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <a
          href={account.external_url ?? '#'}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-accent hover:underline"
        >
          {account.external_id}
        </a>
        <UnlinkButton id={account.id} platform={account.platform} />
      </div>
      {hasRatings && (
        <dl className="grid grid-cols-4 gap-2 text-center">
          {ratings.map(([label, r]) => (
            <div key={label} className="rounded-md bg-background/50 px-2 py-2">
              <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {label}
              </dt>
              <dd className="mt-0.5 text-sm font-semibold">{r ?? '-'}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="text-xs text-muted-foreground">
        ✓ Verified
        {account.last_synced_at && (
          <> · synced {new Date(account.last_synced_at).toLocaleDateString()}</>
        )}
      </p>
    </div>
  );
}

function FlashMessages({
  linked,
  handle,
  lichessError,
  chesscomError,
}: {
  linked?: string;
  handle?: string;
  lichessError?: string;
  chesscomError?: string;
}) {
  if (linked === 'lichess' && handle) {
    return <Banner kind="success">Linked Lichess account @{handle}.</Banner>;
  }
  if (linked === 'chesscom' && handle) {
    return <Banner kind="success">Linked Chess.com account @{handle}.</Banner>;
  }
  if (lichessError) {
    return <Banner kind="error">Couldn&apos;t link Lichess: {humanizeError(lichessError)}.</Banner>;
  }
  if (chesscomError) {
    return (
      <Banner kind="error">Couldn&apos;t link Chess.com: {humanizeError(chesscomError)}.</Banner>
    );
  }
  return null;
}

function humanizeError(code: string): string {
  switch (code) {
    case 'session_expired':
      return 'session expired, try again';
    case 'state_mismatch':
      return 'security check failed, try again';
    case 'token_exchange_failed':
      return 'Lichess rejected the authorization';
    case 'missing_code_or_state':
      return 'Lichess did not return the expected response';
    default:
      return code.replace(/_/g, ' ');
  }
}

function Banner({ kind, children }: { kind: 'success' | 'error'; children: React.ReactNode }) {
  const cls =
    kind === 'success'
      ? 'border-accent/30 bg-accent/5 text-foreground'
      : 'border-destructive/30 bg-destructive/5 text-foreground';
  return <div className={`rounded-lg border px-4 py-3 text-sm ${cls}`}>{children}</div>;
}
