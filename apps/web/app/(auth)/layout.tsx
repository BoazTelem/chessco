import Link from 'next/link';
import { brand } from '@chessco/ui';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="px-6 py-6">
        <Link
          href="/"
          className="text-xs font-semibold uppercase tracking-[0.3em] text-accent hover:opacity-80"
        >
          {brand.name}
        </Link>
      </header>
      <main className="container mx-auto flex flex-1 items-center justify-center px-4 pb-16">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  );
}
