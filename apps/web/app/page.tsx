import Link from 'next/link';
import { brand } from '@chessco/ui';
import { getUser } from '@/lib/auth';
import { ChesscoMark } from '@/lib/logo';
import { getIndexStats } from '@/lib/index-stats';

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
    <main className="container mx-auto flex min-h-screen flex-col items-center justify-center px-4 py-16">
      <div className="flex max-w-3xl flex-col items-center gap-8 text-center">
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

        <div className="mt-4 flex flex-col items-center gap-3 sm:flex-row">
          {user ? (
            <>
              <Link
                href="/scout"
                className="rounded-md bg-accent px-5 py-2.5 text-sm font-semibold text-accent-foreground transition hover:opacity-90"
              >
                Scout players →
              </Link>
              <Link
                href="/dashboard"
                className="rounded-md border border-border bg-card px-5 py-2.5 text-sm font-semibold text-foreground transition hover:bg-muted"
              >
                Dashboard
              </Link>
            </>
          ) : (
            <>
              <Link
                href="/signup"
                className="rounded-md bg-accent px-5 py-2.5 text-sm font-semibold text-accent-foreground transition hover:opacity-90"
              >
                Get started
              </Link>
              <Link
                href="/scout"
                className="rounded-md border border-border bg-card px-5 py-2.5 text-sm font-semibold text-foreground transition hover:bg-muted"
              >
                Try the scout
              </Link>
              <Link
                href="/login"
                className="rounded-md border border-transparent px-5 py-2.5 text-sm font-semibold text-muted-foreground transition hover:text-foreground"
              >
                Sign in
              </Link>
            </>
          )}
        </div>

        <div className="mt-8 flex flex-col gap-3 text-sm">
          <div className="rounded-lg border border-border bg-card px-6 py-4 text-muted-foreground">
            <span className="font-medium text-foreground">
              {stats.total.toLocaleString()} players indexed
            </span>{' '}
            — {stats.federationTotal.toLocaleString()} OTB-rated ({federationsLabel}) plus{' '}
            {stats.platformTotal.toLocaleString()} on chess.com and Lichess. Try the scout, no
            sign-up needed.
          </div>
          <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
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
        </div>
      </div>
    </main>
  );
}
