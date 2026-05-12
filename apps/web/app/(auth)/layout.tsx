import Link from 'next/link';
import { brand } from '@chessco/ui';
import { ChesscoMark } from '@/lib/logo';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="px-6 py-6">
        <Link
          href="/"
          aria-label={brand.name}
          className="inline-flex items-center gap-2 text-sm hover:opacity-80"
        >
          <ChesscoMark className="h-4 w-4 shrink-0" />
          <span className="font-display font-semibold uppercase tracking-[0.3em] text-accent">
            {brand.name}
          </span>
        </Link>
      </header>
      <main className="container mx-auto flex flex-1 items-center justify-center px-4 pb-16">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  );
}
