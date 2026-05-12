import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { signOut } from '../(auth)/actions';

export const metadata = {
  title: 'Dashboard',
};

export default async function DashboardPage() {
  const user = await requireUser();
  const supabase = await createClient();

  const [{ data: profile }, { data: accounts }] = await Promise.all([
    supabase
      .from('profiles')
      .select('username, display_name, country')
      .eq('id', user.id)
      .maybeSingle(),
    supabase
      .from('external_accounts')
      .select('platform, external_id, verified')
      .eq('profile_id', user.id),
  ]);

  if (!profile?.username || !profile?.country) {
    redirect('/onboarding');
  }

  const linked = accounts ?? [];
  const lichess = linked.find((a) => a.platform === 'lichess');
  const chesscom = linked.find((a) => a.platform === 'chess.com');

  return (
    <div className="container mx-auto max-w-3xl space-y-10 px-4 py-12">
      <header className="flex items-start justify-between gap-6">
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">Dashboard</p>
          <h1 className="font-display text-3xl font-bold tracking-tight">
            Welcome, {profile.display_name ?? profile.username}
          </h1>
          <p className="text-sm text-muted-foreground">
            Signed in as <span className="text-foreground">{user.email}</span>
            {profile.country && (
              <>
                {' '}
                · <span className="text-foreground">{profile.country}</span>
              </>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/scout"
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-foreground hover:opacity-90"
          >
            Scout players
          </Link>
          <Link
            href="/account"
            className="rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted"
          >
            Account
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

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Linked accounts
          </h2>
          <Link href="/account" className="text-xs text-accent hover:underline">
            Manage →
          </Link>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <AccountBadge
            name="Lichess"
            handle={lichess?.external_id}
            verified={!!lichess?.verified}
          />
          <AccountBadge
            name="Chess.com"
            handle={chesscom?.external_id}
            verified={!!chesscom?.verified}
          />
        </div>
        {!lichess && !chesscom && (
          <p className="text-xs text-muted-foreground">
            Connect at least one chess account so we can import your games and build prep reports
            against opponents that share your repertoire.
          </p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Available now
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          <LiveCard
            href="/scout"
            label="Live"
            title="Scout players"
            body="755k+ FIDE players. Search by name, country, title, rating range."
          />
          <LiveCard
            href="/account"
            label="Live"
            title="Manage linked accounts"
            body="Verify your Lichess or Chess.com account so we can import your games."
          />
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Coming soon
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          <PlaceholderCard
            label="Phase 0 W6"
            title="Import your games"
            body="Pull your last 200 games from each linked account into Chessco for analysis."
          />
          <PlaceholderCard
            label="Phase 0 W7"
            title="USCF + Israeli CF"
            body="Expand /scout to cover US and Israeli OTB-rated players."
          />
          <PlaceholderCard
            label="Phase 1"
            title="Build a prep report"
            body="Generate a per-opponent battle plan from their public games."
          />
          <PlaceholderCard
            label="Phase 3"
            title="Publish a challenge"
            body="Practice the positions that matter — match with a verified opponent."
          />
        </ul>
      </section>
    </div>
  );
}

function AccountBadge({
  name,
  handle,
  verified,
}: {
  name: string;
  handle?: string;
  verified: boolean;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3">
      <div className="space-y-0.5">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">{name}</p>
        {handle ? (
          <p className="font-medium">@{handle}</p>
        ) : (
          <p className="text-sm text-muted-foreground">Not connected</p>
        )}
      </div>
      {handle ? (
        <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-accent">
          {verified ? '✓ Verified' : 'Pending'}
        </span>
      ) : (
        <Link
          href="/account"
          className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-accent-foreground hover:opacity-90"
        >
          Connect
        </Link>
      )}
    </div>
  );
}

function PlaceholderCard({ label, title, body }: { label: string; title: string; body: string }) {
  return (
    <li className="rounded-lg border border-border bg-card p-5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-accent">{label}</p>
      <p className="mt-1 font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </li>
  );
}

function LiveCard({
  href,
  label,
  title,
  body,
}: {
  href: string;
  label: string;
  title: string;
  body: string;
}) {
  return (
    <li>
      <Link
        href={href}
        className="block rounded-lg border border-accent/30 bg-accent/5 p-5 transition hover:border-accent/60"
      >
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-accent">{label}</p>
        <p className="mt-1 font-medium">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{body}</p>
      </Link>
    </li>
  );
}
