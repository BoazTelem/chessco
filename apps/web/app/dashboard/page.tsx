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
  const { data: profile } = await supabase
    .from('profiles')
    .select('username, display_name, country')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile?.username || !profile?.country) {
    redirect('/onboarding');
  }

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

        <form action={signOut}>
          <button
            type="submit"
            className="rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted"
          >
            Sign out
          </button>
        </form>
      </header>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Coming soon
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          <PlaceholderCard
            label="Phase 0 W4"
            title="Link a chess account"
            body="Verify your Lichess or Chess.com account so we can import your games."
          />
          <PlaceholderCard
            label="Phase 0 W5"
            title="Find a player"
            body="Search the FIDE rating list to find your next opponent."
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

function PlaceholderCard({ label, title, body }: { label: string; title: string; body: string }) {
  return (
    <li className="rounded-lg border border-border bg-card p-5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-accent">{label}</p>
      <p className="mt-1 font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </li>
  );
}
