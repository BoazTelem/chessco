import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CorrelationSection } from './CorrelationSection';
import { OpeningTreeSection } from './OpeningTreeSection';
import { PersonalizedLeaks } from '@/components/prepare/PersonalizedLeaks';
import { getUser } from '@/lib/auth';
import {
  probeChesscomOne,
  probeLichess,
  readCachedProbeHit,
  upsertProbeHits,
  type ProbeHit,
} from '@/lib/scout/lazy-probe';
import { logSearchEvent } from '@/lib/search-events/log';
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

// Cache-first lookup: verify just upserted this row, so the live platform
// probe is only a fallback for cold-cache deep links. The fallback exists
// because direct URL visits (shared links, SEO crawlers) skip verify.
async function resolveOpponent(
  supabase: ReturnType<typeof createAdminClient>,
  platform: 'lichess' | 'chess.com',
  handle: string,
): Promise<ProbeHit | null> {
  const cached = await readCachedProbeHit(supabase, platform, handle).catch(() => null);
  if (cached) return cached;

  const live =
    platform === 'chess.com'
      ? await probeChesscomOne(handle)
      : ((await probeLichess([handle]))[0] ?? null);
  if (!live) return null;

  try {
    await upsertProbeHits(supabase, [live]);
  } catch {
    // intentionally swallowed — render shouldn't fail on a cache write
  }
  return live;
}

export default async function PrepareStubPage({
  params,
  searchParams,
}: {
  params: Promise<RouteParams>;
  searchParams: Promise<{ me?: string; mePlatform?: string }>;
}) {
  const [{ platform: platformSlug, handle: rawHandle }, sp] = await Promise.all([
    params,
    searchParams,
  ]);
  const platform = PLATFORM_SLUGS[platformSlug];
  if (!platform) notFound();

  // Phase 4 wiring: when `?me=...&mePlatform=...` are present we render
  // the correlation engine output. URL-param entry is the v1 surface;
  // a picker + user→handle linking lands separately.
  const mePlatform: 'chess.com' | 'lichess' | null =
    sp.mePlatform === 'chess.com' || sp.mePlatform === 'lichess' ? sp.mePlatform : null;
  const meHandle = sp.me && sp.me.trim().length > 0 ? sp.me.trim() : null;
  const correlationProps = meHandle && mePlatform ? ({ meHandle, mePlatform } as const) : null;

  const handle = decodeURIComponent(rawHandle);
  const supabase = createAdminClient();

  const [user, hit] = await Promise.all([getUser(), resolveOpponent(supabase, platform, handle)]);

  if (!hit) notFound();

  // Audit feed: this is the "found whom" event. Anonymous prep_visits aren't
  // captured anywhere else (prep_reports only inserts when signed-in).
  void logSearchEvent({
    kind: 'prep_visit',
    profileId: user?.id ?? null,
    targetPlatform: platform,
    targetHandle: hit.handle,
  });

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

        <OpeningTreeSection platform={platform} handle={hit.handle} signedIn={Boolean(user)} />

        {correlationProps ? (
          <CorrelationSection
            oppPlatform={platform}
            oppHandle={hit.handle}
            mePlatform={correlationProps.mePlatform}
            meHandle={correlationProps.meHandle}
          />
        ) : null}

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
