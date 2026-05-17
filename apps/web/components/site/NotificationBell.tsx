'use client';

/**
 * NotificationBell — header bell + unread badge + dropdown panel.
 *
 * Server-renders the initial unread count via `initialUnreadCount` to avoid a
 * 0 → real-count flash. Subscribes to Supabase realtime on the `notifications`
 * table filtered by profile_id; INSERTs bump the count + push the row into
 * the dropdown list. Matches the realtime pattern in PracticePresence.tsx.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { NotificationDropdown, type NotificationItem } from './NotificationDropdown';

interface Props {
  userId: string;
  initialUnreadCount: number;
  initialItems: NotificationItem[];
}

export function NotificationBell({ userId, initialUnreadCount, initialItems }: Props) {
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(initialUnreadCount);
  const [items, setItems] = useState<NotificationItem[]>(initialItems);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Subscribe to realtime INSERTs on this user's notifications.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`notifications:${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `profile_id=eq.${userId}`,
        },
        (payload) => {
          const row = payload.new as {
            id: string;
            type: string;
            category: string;
            title: string;
            body: string | null;
            action_url: string | null;
            read_at: string | null;
            created_at: string;
          };
          setItems((prev) => {
            // Realtime may double-fire on reconnect; dedupe by id.
            if (prev.some((p) => p.id === row.id)) return prev;
            return [
              {
                id: row.id,
                type: row.type,
                category: row.category,
                title: row.title,
                body: row.body,
                actionUrl: row.action_url,
                readAt: row.read_at,
                createdAt: row.created_at,
              },
              ...prev,
            ].slice(0, 10);
          });
          if (!payload.new || (payload.new as { read_at: string | null }).read_at == null) {
            setUnreadCount((n) => n + 1);
          }
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'notifications',
          filter: `profile_id=eq.${userId}`,
        },
        (payload) => {
          const row = payload.new as {
            id: string;
            type: string;
            category: string;
            title: string;
            body: string | null;
            action_url: string | null;
            read_at: string | null;
            created_at: string;
          };
          setItems((prev) => {
            const existing = prev.find((item) => item.id === row.id);
            if (row.read_at == null && existing?.readAt != null) {
              setUnreadCount((n) => n + 1);
            }
            const nextItem: NotificationItem = {
              id: row.id,
              type: row.type,
              category: row.category,
              title: row.title,
              body: row.body,
              actionUrl: row.action_url,
              readAt: row.read_at,
              createdAt: row.created_at,
            };
            return [nextItem, ...prev.filter((item) => item.id !== row.id)].slice(0, 10);
          });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const markAllRead = useCallback(async () => {
    const supabase = createClient();
    const { error } = await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('profile_id', userId)
      .is('read_at', null);
    if (!error) {
      setUnreadCount(0);
      setItems((prev) =>
        prev.map((item) => ({
          ...item,
          readAt: item.readAt ?? new Date().toISOString(),
        })),
      );
    }
  }, [userId]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="relative inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/10 hover:text-foreground"
      >
        <BellIcon />
        {unreadCount > 0 ? (
          <span
            aria-hidden="true"
            className="absolute -right-1 -top-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-foreground"
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <NotificationDropdown
          items={items}
          hasUnread={unreadCount > 0}
          onMarkAllRead={markAllRead}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

function BellIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}
