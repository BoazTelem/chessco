'use client';

/**
 * NotificationDropdown — bell popover. Lists the last ~10 notifications,
 * "Mark all read" action, and a "See all" link to /inbox/notifications.
 *
 * Visual style matches LowCreditsDialog.tsx: Tailwind-only, --popover /
 * --border / --card / --muted-foreground custom properties from globals.css.
 */

import Link from 'next/link';

export interface NotificationItem {
  id: string;
  type: string;
  category: string;
  title: string;
  body: string | null;
  actionUrl: string | null;
  readAt: string | null;
  createdAt: string;
}

interface Props {
  items: NotificationItem[];
  hasUnread: boolean;
  onMarkAllRead: () => void | Promise<void>;
  onClose: () => void;
}

export function NotificationDropdown({ items, hasUnread, onMarkAllRead, onClose }: Props) {
  return (
    <div
      role="dialog"
      aria-label="Notifications"
      className="absolute right-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-card shadow-lg"
    >
      <header className="flex items-center justify-between border-b border-border px-3 py-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Notifications
        </p>
        {hasUnread ? (
          <button
            type="button"
            onClick={() => {
              void onMarkAllRead();
            }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Mark all read
          </button>
        ) : null}
      </header>

      {items.length === 0 ? (
        <p className="px-3 py-6 text-center text-sm text-muted-foreground">
          You&apos;re all caught up.
        </p>
      ) : (
        <ul className="max-h-96 overflow-y-auto">
          {items.map((item) => (
            <li key={item.id} className="border-b border-border last:border-b-0">
              <NotificationRow item={item} onClick={onClose} />
            </li>
          ))}
        </ul>
      )}

      <footer className="border-t border-border px-3 py-2 text-center">
        <Link
          href="/inbox/notifications"
          onClick={onClose}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          See all
        </Link>
      </footer>
    </div>
  );
}

function NotificationRow({ item, onClick }: { item: NotificationItem; onClick: () => void }) {
  const content = (
    <div className="block px-3 py-2 hover:bg-accent/5">
      <div className="flex items-start gap-2">
        {item.readAt == null ? (
          <span
            aria-hidden="true"
            className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full bg-accent"
          />
        ) : (
          <span className="mt-1.5 inline-block h-2 w-2 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{item.title}</p>
          {item.body ? (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.body}</p>
          ) : null}
          <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            {formatRelative(item.createdAt)}
          </p>
        </div>
      </div>
    </div>
  );

  if (item.actionUrl) {
    return (
      <Link href={item.actionUrl} onClick={onClick}>
        {content}
      </Link>
    );
  }
  return content;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.max(0, Math.floor((now - then) / 1000));
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 7 * 86_400) return `${Math.floor(diffSec / 86_400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
