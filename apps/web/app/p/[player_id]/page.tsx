import Link from 'next/link';
import { notFound } from 'next/navigation';
import { brand } from '@chessco/ui';
import { getUser } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { ChesscoMark } from '@/lib/logo';
import { CountryBadge, FederationBadge, TitleBadge } from '../../scout/result-card';
import { SampleGameForm } from '../../scout/sample-game-form';
import { IdentifyButton } from './identify-button';

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

  // Confirmed online accounts for this FIDE player (user_confirmed = true).
  // Multiple queries may have produced the same (platform, handle) — dedupe
  // client-side, keeping the highest-scoring instance per handle.
  const { data: rawConfirmed } = (await supabase
    .from('identification_candidates')
    .select('platform, handle, combined_score, evidence')
    .eq('federation_player_id', player_id)
    .eq('user_confirmed', true)
    .order('combined_score', { ascending: false })) as {
    data:
      | {
          platform: 'lichess' | 'chess.com';
          handle: string;
          combined_score: number;
          evidence: { country?: string | null; title?: string | null } | null;
        }[]
      | null;
  };
  const seenAccounts = new Set<string>();
  const confirmedAccounts = (rawConfirmed ?? []).filter((a) => {
    const key = `${a.platform}:${a.handle}`;
    if (seenAccounts.has(key)) return false;
    seenAccounts.add(key);
    return true;
  });

  const ratings: Array<[string, number | null]> = [
    ['Standard', player.rating_standard],
    ['Rapid', player.rating_rapid],
    ['Blitz', player.rating_blitz],
  ];

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-card/50">
        <div className="container mx-auto flex items-center justify-between px-4 py-4">
          <div className="flex items-center gap-2 text-sm">
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
            <span className="text-muted-foreground">/</span>
            <Link href="/scout" className="text-muted-foreground hover:text-foreground">
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

        {confirmedAccounts.length > 0 && (
          <section className="mt-10">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Known online accounts
            </h2>
            <ul className="mt-3 space-y-2">
              {confirmedAccounts.map((a) => (
                <li
                  key={`${a.platform}-${a.handle}`}
                  className="flex items-center justify-between rounded-md border border-emerald-500/30 bg-emerald-500/5 px-4 py-3"
                >
                  <div>
                    <a
                      href={
                        a.platform === 'lichess'
                          ? `https://lichess.org/@/${a.handle}`
                          : `https://www.chess.com/member/${a.handle}`
                      }
                      target="_blank"
                      rel="noreferrer noopener"
                      className="font-display font-semibold tracking-tight hover:text-accent"
                    >
                      {a.handle}
                    </a>
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {a.platform}
                    </p>
                  </div>
                  <span className="text-xs font-medium uppercase tracking-wider text-emerald-500">
                    Confirmed
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Find their online accounts
          </h2>
          <div className="mt-3 space-y-5 rounded-lg border border-border bg-card p-5">
            {/* Method 1: quick name search */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Quick name search
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Match {player.name.split(',')[0] ?? player.name} to their Lichess and chess.com
                accounts via fuzzy name + country + rating-band on our online-handle corpus. Fastest
                path — works without sample games.
              </p>
              <div className="mt-3">
                <IdentifyButton federationPlayerId={player.id} />
              </div>
            </div>

            {/* Divider */}
            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-border" />
              <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                or
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>

            {/* Method 2: AI matching by sample game */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-accent">
                AI matching by sample game
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Have games of {player.name.split(',')[0] ?? player.name}? Paste them below for
                precise identification by play pattern — the AI Scout finds their accounts even when
                their handle looks nothing like their name. Works best with 10+ games.
              </p>
              <div className="mt-3">
                <SampleGameForm federationPlayerId={player.id} subjectLabel={player.name} />
              </div>
            </div>
          </div>
        </section>

        <section className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Coming soon
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <PlaceholderCard
              label="Phase 1 W5"
              title="By sample game"
              body="Paste 1+ PGNs of the target player and run AI stylometric matching across millions of profiles."
            />
            <PlaceholderCard
              label="Phase 1 W7-W9"
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
