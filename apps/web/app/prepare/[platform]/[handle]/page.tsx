import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getUser } from '@/lib/auth';
import { probeChesscomOne, probeLichess, upsertProbeHits } from '@/lib/scout/lazy-probe';
import { createAdminClient } from '@/lib/supabase/admin';

// Stub renderer for the standalone Preparation entry. Real opening tree +
// leak detection ship in Phase 1 W6–W9. This page exists to anchor the
// `/prepare` URL space, verify the handle, and show the right CTA based on
// auth state. Refresh aggressively while the stub is up; long cache once
// real aggregates land.
export const revalidate = 0;

const PLATFORM_SLUGS: Record<string, 'chess.com' | 'lichess'> = {
  chesscom: 'chess.com',
  lichess: 'lichess',
};

interface RouteParams {
  platform: string;
  handle: string;
}

export default async function PrepareStubPage({ params }: { params: Promise<RouteParams> }) {
  const { platform: platformSlug, handle: rawHandle } = await params;
  const platform = PLATFORM_SLUGS[platformSlug];
  if (!platform) notFound();

  const handle = decodeURIComponent(rawHandle);

  const [user, hit] = await Promise.all([
    getUser(),
    platform === 'chess.com'
      ? probeChesscomOne(handle)
      : probeLichess([handle]).then((arr) => arr[0] ?? null),
  ]);

  if (!hit) notFound();

  // Warm the platform_players cache so the next Scout query against this
  // name lands instantly. Best-effort; never block render on it.
  try {
    await upsertProbeHits(createAdminClient(), [hit]);
  } catch {
    // intentionally swallowed
  }

  const ratings = [
    hit.rating_bullet !== null ? { label: 'Bullet', value: hit.rating_bullet } : null,
    hit.rating_blitz !== null ? { label: 'Blitz', value: hit.rating_blitz } : null,
    hit.rating_rapid !== null ? { label: 'Rapid', value: hit.rating_rapid } : null,
    hit.rating_classical !== null ? { label: 'Classical', value: hit.rating_classical } : null,
  ].filter((r): r is { label: string; value: number } => r !== null);

  return (
    <main className="container mx-auto flex min-h-screen flex-col px-4 py-10">
      <div className="mx-auto w-full max-w-3xl space-y-8">
        <nav className="text-xs text-muted-foreground">
          <Link href="/prepare" className="hover:text-foreground">
            ← Prepare against a different opponent
          </Link>
        </nav>

        <header className="space-y-2">
          <p className="font-display text-xs uppercase tracking-[0.3em] text-accent">Prep target</p>
          <h1 className="font-display text-3xl font-bold tracking-tight md:text-4xl">
            {hit.handle}
          </h1>
          <p className="text-sm text-muted-foreground">
            {platform === 'chess.com' ? 'chess.com' : 'Lichess'}
            {hit.claimed_name ? ` · ${hit.claimed_name}` : ''}
            {hit.country ? ` · ${hit.country}` : ''}
            {hit.title ? ` · ${hit.title}` : ''}
          </p>
          {ratings.length > 0 ? (
            <ul className="flex flex-wrap gap-2 pt-2">
              {ratings.map((r) => (
                <li
                  key={r.label}
                  className="rounded-md border border-border bg-card px-2.5 py-1 text-xs"
                >
                  <span className="text-muted-foreground">{r.label} </span>
                  <span className="font-semibold text-foreground">{r.value}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </header>

        <section className="rounded-xl border border-border bg-card p-6">
          <h2 className="font-display text-xl font-semibold">Opening tree</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The interactive opening tree for {hit.handle} ships in Phase 1 W6 — we&rsquo;re building
            the games corpus this week. Tree + frequency, win rate, and average centipawn loss per
            node, with embedded board widgets. Free for everyone.
          </p>
          <div className="mt-4 rounded-md border border-dashed border-border bg-background/60 px-4 py-6 text-center text-xs uppercase tracking-wider text-muted-foreground">
            Tree placeholder — coming W6
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-6">
          <h2 className="font-display text-xl font-semibold">Personalized leaks</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Positions where {hit.handle} has played poorly that you can reach from your own
            repertoire — plus 2–3 surprise lines to catch them off-guard.
          </p>
          {user ? (
            <div className="mt-4 rounded-md border border-dashed border-border bg-background/60 px-4 py-6 text-center text-xs uppercase tracking-wider text-muted-foreground">
              Leak report — generating from your imported games (Phase 1 W7)
            </div>
          ) : (
            <div className="mt-4 flex flex-col items-start gap-3 rounded-md border border-accent/30 bg-accent/5 px-4 py-4">
              <p className="text-sm text-foreground">
                Sign in to correlate leaks with your repertoire.
              </p>
              <Link
                href={`/login?redirect=${encodeURIComponent(`/prepare/${platformSlug}/${rawHandle}`)}`}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground transition hover:opacity-90"
              >
                Sign in
              </Link>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
