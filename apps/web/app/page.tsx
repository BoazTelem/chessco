import Link from 'next/link';
import { brand } from '@chessco/ui';
import { getUser } from '@/lib/auth';

export default async function HomePage() {
  const user = await getUser();

  return (
    <main className="container mx-auto flex min-h-screen flex-col items-center justify-center px-4 py-16">
      <div className="flex max-w-3xl flex-col items-center gap-8 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">{brand.name}</p>

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
            <span className="font-medium text-foreground">755,081 FIDE players indexed.</span> Try
            the scout above — no sign-up needed. Prep reports next.
          </div>
          <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <span>Scout</span>
            <span className="text-accent">→</span>
            <span>Find</span>
            <span className="text-accent">→</span>
            <span>Practice</span>
            <span className="text-accent">→</span>
            <span>Pay</span>
            <span className="text-accent">→</span>
            <span>Improve</span>
          </div>
        </div>
      </div>
    </main>
  );
}
