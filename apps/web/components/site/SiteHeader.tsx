import Link from 'next/link';
import { brand } from '@chessco/ui';
import { ChesscoMark } from '@/lib/logo';
import { getUser } from '@/lib/auth';

export async function SiteHeader() {
  const user = await getUser();

  return (
    <header className="border-b border-border bg-card/50">
      <div className="container mx-auto flex items-center justify-between gap-4 px-4 py-4">
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

        <nav className="hidden items-center gap-5 text-sm md:flex">
          <Link href="/scout" className="text-muted-foreground hover:text-foreground">
            Scout
          </Link>
          <Link href="/prepare" className="text-muted-foreground hover:text-foreground">
            Prepare
          </Link>
          <Link href="/practice" className="text-muted-foreground hover:text-foreground">
            Practice
          </Link>
        </nav>

        <nav className="flex items-center gap-3 text-sm">
          {user ? (
            <>
              <Link href="/dashboard" className="text-muted-foreground hover:text-foreground">
                Dashboard
              </Link>
              <Link href="/account" className="text-muted-foreground hover:text-foreground">
                Account
              </Link>
            </>
          ) : (
            <>
              <Link href="/login" className="text-muted-foreground hover:text-foreground">
                Sign in
              </Link>
              <Link
                href="/signup"
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground hover:opacity-90"
              >
                Get started
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
