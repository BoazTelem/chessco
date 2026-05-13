import Link from 'next/link';
import { notFound } from 'next/navigation';
import { OpeningTreeSection } from './OpeningTreeSection';
import { getUser } from '@/lib/auth';
import { probeChesscomOne, probeLichess, upsertProbeHits } from '@/lib/scout/lazy-probe';
import { createAdminClient } from '@/lib/supabase/admin';

// Standalone Preparation entry. The opening tree is a client-side
// on-demand build (Phase 1 W2 wedge): the browser streams games from the
// platform API and aggregates a recency-weighted tree. Personalized leak
// detection ships in W7; the W6 corpus-backed builder replaces this
// client-side version with persisted aggregates.
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
      <div className="mx-auto w-full max-w-6xl space-y-8">
        <nav className="mx-auto w-full max-w-3xl text-xs text-muted-foreground">
          <Link href="/prepare" className="hover:text-foreground">
            ← Prepare against a different opponent
          </Link>
        </nav>

        <header className="mx-auto w-full max-w-3xl space-y-2">
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

        <OpeningTreeSection platform={platform} handle={hit.handle} />

        <section className="mx-auto w-full max-w-3xl rounded-xl border border-border bg-card p-6">
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
