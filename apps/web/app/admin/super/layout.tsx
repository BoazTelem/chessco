import Link from 'next/link';
import type { ReactNode } from 'react';
import { requireSuperAdmin } from '@/lib/auth';
import { signOut } from '../../(auth)/actions';

export const metadata = {
  title: 'Super Admin',
  robots: { index: false, follow: false },
};

const TABS = [
  { href: '/admin/super', label: 'Overview' },
  { href: '/admin/super/users', label: 'Users' },
  { href: '/admin/super/searches', label: 'Searches' },
  { href: '/admin/super/revenue', label: 'Revenue' },
  { href: '/admin/super/games', label: 'Games' },
  { href: '/admin/super/prep', label: 'Prep' },
  { href: '/admin/super/moderation', label: 'Moderation' },
  { href: '/admin/super/system', label: 'System' },
];

export default async function SuperAdminLayout({ children }: { children: ReactNode }) {
  const user = await requireSuperAdmin();

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-card/40">
        <div className="container mx-auto flex max-w-6xl items-center justify-between gap-6 px-4 py-4">
          <div className="flex items-center gap-6">
            <Link href="/admin/super" className="space-y-0.5">
              <p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-accent">
                Super Admin
              </p>
              <p className="font-display text-lg font-bold tracking-tight">Chessco Ops</p>
            </Link>
            <nav className="hidden flex-wrap items-center gap-1 md:flex">
              {TABS.map((t) => (
                <Link
                  key={t.href}
                  href={t.href}
                  className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
                >
                  {t.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-muted-foreground md:inline">{user.email}</span>
            <Link
              href="/dashboard"
              className="rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-muted"
            >
              Exit
            </Link>
            <form action={signOut}>
              <button
                type="submit"
                className="rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-muted"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
        <nav className="container mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 pb-3 md:hidden">
          {TABS.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className="rounded-md px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              {t.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="container mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
