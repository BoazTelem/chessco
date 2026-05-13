import Link from 'next/link';
import { brand } from '@chessco/ui';
import { getUser } from '@/lib/auth';
import { ChesscoMark } from '@/lib/logo';
import { getIndexStats } from '@/lib/index-stats';
import { PillarTile } from '@/components/home/pillar-tile';
import { PositionWaitlistForm } from '@/components/home/position-waitlist-form';

// Refresh the indexed-player count once a day. Federation crons run
// monthly and the chess.com crawler is continuous, so daily cadence
// keeps the hero banner honest without hammering the DB.
export const revalidate = 86_400;

export default async function HomePage() {
  const [user, stats] = await Promise.all([getUser(), getIndexStats()]);
  const federations: string[] = ['FIDE'];
  if (stats.uscf > 0) federations.push('USCF');
  if (stats.icf > 0) federations.push('ICF');
  const federationsLabel = federations.join(' + ');

  return (
    <main className="container mx-auto flex min-h-screen flex-col items-center px-4 py-16">
      <div className="flex w-full max-w-5xl flex-col items-center gap-10 text-center">
        <div className="flex flex-col items-center gap-5">
          <ChesscoMark variant="float" className="h-[200px] w-[200px] md:h-[240px] md:w-[240px]" />
          <p className="font-display pl-3 text-2xl font-medium uppercase tracking-[0.3em] text-accent md:text-[1.777rem] md:leading-9">
            {brand.name}
          </p>
        </div>

        <h1 className="font-display text-5xl font-bold tracking-tight md:text-7xl">
          {brand.slogan}
        </h1>

        <p className="max-w-2xl text-lg text-muted-foreground md:text-xl">{brand.description}</p>

        <div className="flex items-center justify-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
          <span>Scout</span>
          <span className="text-accent">→</span>
          <span>Find</span>
          <span className="text-accent">→</span>
          <span>Prepare</span>
          <span className="text-accent">→</span>
          <span>Practice</span>
          <span className="text-accent">→</span>
          <span>Win</span>
        </div>

        <div className="grid w-full gap-4 md:grid-cols-3">
          <PillarTile
            index={1}
            title="Scout an opponent"
            subtitle="You only know their name. We search FIDE, USCF, and ICF, then find their chess.com and Lichess accounts."
            cta="Search players"
            href="/scout"
          />
          <PillarTile
            index={2}
            title="Prepare against an opponent"
            subtitle="You know their chess.com or Lichess account. Free opening tree — sign in for personalized leaks and surprise lines."
            cta="Open prep"
            href="/prepare"
          />
          <PillarTile
            index={3}
            title="Practice from a position"
            subtitle="Publish a FEN, set a per-game budget, pick bullet / blitz / rapid / classical, get matched with a verified opponent."
            cta="Get notified"
            badge="Coming soon"
          >
            <PositionWaitlistForm />
          </PillarTile>
        </div>

        <div className="flex flex-col items-center gap-3 text-sm">
          <div className="rounded-lg border border-border bg-card px-6 py-4 text-muted-foreground">
            <span className="font-medium text-foreground">
              {stats.total.toLocaleString()} players indexed
            </span>{' '}
            — {stats.federationTotal.toLocaleString()} OTB-rated ({federationsLabel}) plus{' '}
            {stats.platformTotal.toLocaleString()} on chess.com and Lichess. Try the scout, no
            sign-up needed.
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {user ? (
              <Link href="/dashboard" className="hover:text-foreground">
                Dashboard
              </Link>
            ) : (
              <>
                <Link href="/signup" className="hover:text-foreground">
                  Create account
                </Link>
                <span aria-hidden>·</span>
                <Link href="/login" className="hover:text-foreground">
                  Sign in
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
