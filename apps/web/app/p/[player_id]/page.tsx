import Link from 'next/link';
import { notFound } from 'next/navigation';
import { brand } from '@chessco/ui';
import { getUser } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { ChesscoLockup } from '@/lib/logo';
import { CountryBadge, FederationBadge, TitleBadge } from '../../scout/result-card';

export const metadata = {
  title: 'Player profile',
};

type FederationPlayer = {
  id: string;
  federation_id: string;
  federation_player_id: string;
  name: string;
  country: string | null;
  title: string | null;
  rating_standard: number | null;
  rating_rapid: number | null;
  rating_blitz: number | null;
  birth_year: number | null;
  last_updated_at: string;
};

type Snapshot = {
  snapshot_date: string;
  rating_standard: number | null;
  rating_rapid: number | null;
  rating_blitz: number | null;
};

export default async function PlayerProfilePage({
  params,
}: {
  params: Promise<{ player_id: string }>;
}) {
  const { player_id } = await params;
  const user = await getUser();
  const supabase = await createClient();

  const { data: player } = (await supabase
    .from('federation_players')
    .select(
      'id, federation_id, federation_player_id, name, country, title, rating_standard, rating_rapid, rating_blitz, birth_year, last_updated_at',
    )
    .eq('id', player_id)
    .maybeSingle()) as { data: FederationPlayer | null };

  if (!player) notFound();

  const { data: snapshots } = (await supabase
    .from('federation_rating_snapshots')
    .select('snapshot_date, rating_standard, rating_rapid, rating_blitz')
    .eq('federation_player_id', player_id)
    .order('snapshot_date', { ascending: false })
    .limit(24)) as { data: Snapshot[] | null };

  const history = (snapshots ?? []).slice().reverse(); // chronological for the chart

  const ratings: Array<[string, number | null]> = [
    ['Standard', player.rating_standard],
    ['Rapid', player.rating_rapid],
    ['Blitz', player.rating_blitz],
  ];

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-card/50">
        <div className="container mx-auto flex items-center justify-between px-4 py-4">
          <div className="flex items-center gap-3">
            <Link href="/" aria-label={brand.name} className="text-sm hover:opacity-80">
              <ChesscoLockup wordmarkClassName="font-display font-semibold uppercase tracking-[0.3em] text-accent" />
            </Link>
            <span className="text-muted-foreground">/</span>
            <Link href="/scout" className="text-sm text-muted-foreground hover:text-foreground">
              Scout
            </Link>
          </div>
          <nav className="flex items-center gap-3 text-sm">
            {user ? (
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

      <main className="container mx-auto max-w-4xl px-4 py-10">
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <FederationBadge code={player.federation_id} />
            {player.title && <TitleBadge title={player.title} />}
            {player.country && <CountryBadge code={player.country} />}
          </div>
          <h1 className="font-display text-4xl font-bold tracking-tight">{player.name}</h1>
          <p className="text-sm text-muted-foreground">
            {player.federation_id} ID {player.federation_player_id}
            {player.birth_year && <> · born {player.birth_year}</>} · last updated{' '}
            {new Date(player.last_updated_at).toLocaleDateString()}
          </p>
        </section>

        <section className="mt-8 grid gap-3 sm:grid-cols-3">
          {ratings.map(([label, r]) => (
            <div key={label} className="rounded-lg border border-border bg-card p-5">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
              <p className="mt-1 font-display text-3xl font-bold tabular-nums">{r ?? '—'}</p>
            </div>
          ))}
        </section>

        {history.length > 1 && (
          <section className="mt-8">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Rating history ({history.length} snapshots)
            </h2>
            <div className="mt-3 rounded-lg border border-border bg-card p-5">
              <RatingChart history={history} />
            </div>
          </section>
        )}

        <section className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Coming soon
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <PlaceholderCard
              label="Phase 1"
              title="Match online accounts"
              body="Find this player's Lichess + Chess.com handles via stylometric matching."
            />
            <PlaceholderCard
              label="Phase 1"
              title="Build prep report"
              body="Per-opponent battle plan: their repertoire, leaks, recommended lines, practice positions."
            />
          </div>
        </section>
      </main>
    </div>
  );
}

function RatingChart({ history }: { history: Snapshot[] }) {
  // Simple inline-SVG sparkline of the standard rating over time.
  const points = history.map((h) => h.rating_standard).filter((r): r is number => r != null);

  if (points.length < 2) {
    return <p className="text-sm text-muted-foreground">Not enough rating history yet.</p>;
  }

  const width = 600;
  const height = 120;
  const padding = 8;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const stepX = (width - padding * 2) / (points.length - 1);

  const path = points
    .map((p, i) => {
      const x = padding + i * stepX;
      const y = padding + (height - padding * 2) * (1 - (p - min) / range);
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <div className="space-y-2">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" preserveAspectRatio="none">
        <path
          d={path}
          fill="none"
          stroke="hsl(var(--accent))"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </svg>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{history[0]?.snapshot_date}</span>
        <span>
          {min} – {max} (range {range})
        </span>
        <span>{history[history.length - 1]?.snapshot_date}</span>
      </div>
    </div>
  );
}

function PlaceholderCard({ label, title, body }: { label: string; title: string; body: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-accent">{label}</p>
      <p className="mt-1 font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
