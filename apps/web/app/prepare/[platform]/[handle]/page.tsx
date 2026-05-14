import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { OpeningTreeSection } from './OpeningTreeSection';
import { PersonalizedLeaks } from '@/components/prepare/PersonalizedLeaks';
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

const PLATFORM_DISPLAY: Record<string, string> = {
  chesscom: 'chess.com',
  lichess: 'lichess.org',
};

interface RouteParams {
  platform: string;
  handle: string;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<RouteParams>;
}): Promise<Metadata> {
  const { platform: platformSlug, handle: rawHandle } = await params;
  const display = PLATFORM_DISPLAY[platformSlug];
  if (!display) return { title: 'Prepare against an opponent' };
  const handle = decodeURIComponent(rawHandle);
  const title = `Prepare to play chess against ${handle} (${display})`;
  return {
    title,
    description: `Opening tree, repertoire leaks, and prep report for ${display} user ${handle}. Build a battle plan before your next game.`,
    alternates: {
      canonical: `/prepare/${platformSlug}/${rawHandle}`,
    },
  };
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

        <PersonalizedLeaks
          signedIn={Boolean(user)}
          platform={platform}
          handle={hit.handle}
          loginHref={`/login?redirect=${encodeURIComponent(`/prepare/${platformSlug}/${rawHandle}`)}`}
        />
      </div>
    </main>
  );
}
