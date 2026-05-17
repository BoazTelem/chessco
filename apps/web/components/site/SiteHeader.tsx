import Link from 'next/link';
import { brand } from '@chessco/ui';
import { ChesscoMark } from '@/lib/logo';
import { getUser } from '@/lib/auth';
import { getPracticeDb } from '@/lib/practice/db';
import { NotificationBell } from './NotificationBell';
import type { NotificationItem } from './NotificationDropdown';

interface NotificationsBundle {
  unreadCount: number;
  items: NotificationItem[];
}

async function loadNotificationsHeader(userId: string): Promise<NotificationsBundle> {
  // Best-effort: header should never break when the DB hiccups.
  try {
    const sql = getPracticeDb();
    const rows = (await sql`
      SELECT
        id::text,
        type,
        category,
        title,
        body,
        action_url,
        read_at::text,
        created_at::text
      FROM notifications
      WHERE profile_id = ${userId}::uuid
      ORDER BY created_at DESC
      LIMIT 10
    `) as Array<{
      id: string;
      type: string;
      category: string;
      title: string;
      body: string | null;
      action_url: string | null;
      read_at: string | null;
      created_at: string;
    }>;
    const items: NotificationItem[] = rows.map((r) => ({
      id: r.id,
      type: r.type,
      category: r.category,
      title: r.title,
      body: r.body,
      actionUrl: r.action_url,
      readAt: r.read_at,
      createdAt: r.created_at,
    }));
    const unreadRows = (await sql`
      SELECT COUNT(*)::int AS n
      FROM notifications
      WHERE profile_id = ${userId}::uuid AND read_at IS NULL
    `) as Array<{ n: number }>;
    return { unreadCount: Number(unreadRows[0]?.n ?? 0), items };
  } catch {
    return { unreadCount: 0, items: [] };
  }
}

export async function SiteHeader() {
  const user = await getUser();
  const notifications = user ? await loadNotificationsHeader(user.id) : null;

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
          <Link href="/hall-of-fame" className="text-muted-foreground hover:text-foreground">
            Hall of Fame
          </Link>
          <Link href="/pricing" className="text-muted-foreground hover:text-foreground">
            Pricing
          </Link>
        </nav>

        <nav className="flex items-center gap-3 text-sm">
          {user && notifications ? (
            <>
              <NotificationBell
                userId={user.id}
                initialUnreadCount={notifications.unreadCount}
                initialItems={notifications.items}
              />
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
