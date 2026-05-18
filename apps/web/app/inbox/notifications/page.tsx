/**
 * /inbox/notifications: full list of in-app notifications for the logged-in
 * user. Marks all unread rows as read on view (server-side, idempotent).
 *
 * Pagination is keyset-by-created_at via the `before` search param. Page size
 * is 50, enough to cover a couple of days of activity without bloating the
 * server render.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getUser } from '@/lib/auth';
import { getPracticeDb } from '@/lib/practice/db';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Notifications · Chessco',
  robots: { index: false, follow: false },
};

const PAGE_SIZE = 50;

interface Row {
  id: string;
  type: string;
  category: string;
  title: string;
  body: string | null;
  data: Record<string, unknown>;
  action_url: string | null;
  read_at: string | null;
  created_at: string;
}

async function loadAndMarkRead(userId: string, before: string | null): Promise<Row[]> {
  const sql = getPracticeDb();

  // Mark everything older-or-equal-to-now as read in one shot. The realtime
  // bell will pick the change up via the UPDATE listener.
  await sql`
    UPDATE notifications
    SET read_at = NOW()
    WHERE profile_id = ${userId}::uuid AND read_at IS NULL
  `;

  if (before) {
    return sql<Row[]>`
      SELECT id::text, type, category, title, body, data,
             action_url, read_at::text, created_at::text
      FROM notifications
      WHERE profile_id = ${userId}::uuid
        AND created_at < ${before}::timestamptz
      ORDER BY created_at DESC
      LIMIT ${PAGE_SIZE}
    `;
  }
  return sql<Row[]>`
    SELECT id::text, type, category, title, body, data,
           action_url, read_at::text, created_at::text
    FROM notifications
    WHERE profile_id = ${userId}::uuid
    ORDER BY created_at DESC
    LIMIT ${PAGE_SIZE}
  `;
}

export default async function InboxNotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ before?: string }>;
}) {
  const user = await getUser();
  if (!user) redirect('/login?next=/inbox/notifications');

  const params = await searchParams;
  const before = typeof params.before === 'string' ? params.before : null;

  const rows = await loadAndMarkRead(user.id, before);
  const groups = groupByDay(rows);
  const olderCursor = rows.length === PAGE_SIZE ? rows[rows.length - 1]!.created_at : null;

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 md:py-12">
      <header className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Inbox</p>
          <h1 className="mt-1 font-display text-2xl font-semibold md:text-3xl">Notifications</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Everything that happened to your account.
          </p>
        </div>
        <nav className="flex items-center gap-3 text-sm">
          <Link href="/inbox/invitations" className="text-muted-foreground hover:text-foreground">
            Invitations →
          </Link>
          <Link
            href="/account/notifications"
            className="text-muted-foreground hover:text-foreground"
          >
            Preferences →
          </Link>
        </nav>
      </header>

      {rows.length === 0 ? (
        <p className="mt-8 rounded-md border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
          You&apos;re all caught up. New notifications will appear here.
        </p>
      ) : (
        <div className="mt-8 space-y-8">
          {groups.map((group) => (
            <section key={group.label}>
              <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {group.label}
              </h2>
              <ul className="mt-3 grid gap-2">
                {group.rows.map((row) => (
                  <li key={row.id} className="rounded-md border border-border bg-card px-4 py-3">
                    <NotificationView row={row} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {olderCursor ? (
        <div className="mt-8 text-center">
          <Link
            href={`/inbox/notifications?before=${encodeURIComponent(olderCursor)}`}
            className="rounded-md border border-border bg-card px-4 py-2 text-xs text-muted-foreground hover:text-foreground"
          >
            Show older
          </Link>
        </div>
      ) : null}
    </main>
  );
}

function NotificationView({ row }: { row: Row }) {
  const title = (
    <p className="font-semibold">
      <CategoryBadge category={row.category} /> {row.title}
    </p>
  );
  const body = row.body ? <p className="mt-1 text-sm text-muted-foreground">{row.body}</p> : null;
  const time = (
    <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
      {new Date(row.created_at).toLocaleString()}
    </p>
  );

  if (row.action_url) {
    return (
      <Link href={row.action_url} className="block hover:opacity-80">
        {title}
        {body}
        {time}
      </Link>
    );
  }
  return (
    <>
      {title}
      {body}
      {time}
    </>
  );
}

function CategoryBadge({ category }: { category: string }) {
  const label = category === 'moderation' ? 'Mod' : category === 'credits' ? 'Credits' : 'Social';
  return (
    <span className="mr-1 inline-block rounded bg-muted px-1.5 py-0.5 align-middle text-[10px] uppercase tracking-wide text-muted-foreground">
      {label}
    </span>
  );
}

interface DayGroup {
  label: string;
  rows: Row[];
}

function groupByDay(rows: Row[]): DayGroup[] {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = row.created_at.slice(0, 10);
    const arr = groups.get(key);
    if (arr) arr.push(row);
    else groups.set(key, [row]);
  }
  const today = new Date().toISOString().slice(0, 10);
  const yesterdayDate = new Date();
  yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
  const yesterday = yesterdayDate.toISOString().slice(0, 10);
  return Array.from(groups.entries()).map(([key, items]) => ({
    label: key === today ? 'Today' : key === yesterday ? 'Yesterday' : key,
    rows: items,
  }));
}
