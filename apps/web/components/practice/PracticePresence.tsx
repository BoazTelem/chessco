'use client';

/**
 * PracticePresence — the publisher's lifeline while their challenge sits in
 * the lobby, plus the always-on bridge for direct invites. Mounted globally
 * so the user can navigate to /prepare or /scout (etc.) while waiting and
 * still:
 *   1. Be auto-redirected to /practice/g/[matchId] the moment an opponent
 *      accepts (Realtime postgres_changes on `matches` INSERT, RLS-filtered).
 *   2. Keep their challenge alive via a 20 s heartbeat ping. The lobby hides
 *      anything whose heartbeat is older than 45 s, so opponents never get
 *      stranded waiting for an offline creator.
 *   3. Cancel their open challenges on tab close (best-effort sendBeacon).
 *      Crashes / kills still fall through to the heartbeat-staleness path.
 *   4. Show themselves in the global `practice-presence` Realtime channel so
 *      the InvitePicker (and any future "who's online" UI) can list them.
 *   5. Receive direct invite notifications (postgres_changes on `challenges`
 *      INSERT where target_opponent_id = me) and surface an Accept toast.
 *
 * Renders a small "Waiting for opponent" chip only when there's at least one
 * open challenge to wait on (server tells us via { bumped }).
 */

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { clearPresence, setPresenceFromState } from '@/lib/practice/presence-store';
import type { RealtimeChannel } from '@supabase/supabase-js';

const HEARTBEAT_MS = 20_000;
const LAST_JOINED_KEY = 'practice:last-joined-match';

interface InviteNotice {
  challengeId: string;
  fromName: string;
  timeControl: string;
}

export function PracticePresence() {
  const router = useRouter();
  const pathname = usePathname();
  const [openCount, setOpenCount] = useState(0);
  const [invite, setInvite] = useState<InviteNotice | null>(null);
  const [accepting, setAccepting] = useState(false);
  // Tracks the most recent matchId we've already routed to, so the heartbeat
  // fallback doesn't keep re-pushing the same route on every 20 s tick — and
  // doesn't bounce the user straight back into a game they just left if they
  // reload /practice within the auto-join window. Persisted to sessionStorage
  // so a refresh of the lobby tab honors the "already joined" decision.
  const lastJoinedRef = useRef<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let channel: RealtimeChannel | null = null;

    // Hydrate from sessionStorage so a reload doesn't re-trigger the join.
    try {
      lastJoinedRef.current = sessionStorage.getItem(LAST_JOINED_KEY);
    } catch {
      /* sessionStorage unavailable — fall through with null */
    }

    function rememberJoined(matchId: string): void {
      lastJoinedRef.current = matchId;
      try {
        sessionStorage.setItem(LAST_JOINED_KEY, matchId);
      } catch {
        /* ignore */
      }
    }

    function maybeJoin(matchId: string | null): void {
      if (!matchId) return;
      if (lastJoinedRef.current === matchId) return;
      // Don't yank the user out of a game already in progress.
      if (window.location.pathname.startsWith('/practice/g/')) {
        rememberJoined(matchId);
        return;
      }
      rememberJoined(matchId);
      router.push(`/practice/g/${matchId}`);
    }

    async function ping(): Promise<void> {
      try {
        const res = await fetch('/api/practice/heartbeat', { method: 'POST' });
        if (!res.ok) return;
        const json = (await res.json()) as {
          bumped?: number;
          latestLiveMatchId?: string | null;
        };
        if (cancelled) return;
        setOpenCount(json.bumped ?? 0);
        // Fallback: catches anything Realtime missed (max ~20 s lag).
        maybeJoin(json.latestLiveMatchId ?? null);
      } catch {
        /* ignore network blips — next tick will retry */
      }
    }

    async function init(): Promise<void> {
      const { data } = await supabase.auth.getUser();
      if (cancelled || !data.user) return;
      const userId = data.user.id;

      // Fetch our display info once so InvitePicker can render a friendly
      // name without hitting the DB per peer.
      const { data: profile } = await supabase
        .from('profiles')
        .select('display_name, username')
        .eq('id', userId)
        .maybeSingle();

      channel = supabase.channel('practice-presence', {
        config: { presence: { key: userId } },
      });

      // Presence callbacks must be attached BEFORE subscribe(). InvitePicker
      // (and any other consumer) reads the resulting list from presence-store
      // rather than opening its own channel — supabase.channel(topic) returns
      // the existing channel by topic, so a second subscriber on the same
      // topic would hit "cannot add presence callbacks after subscribe()".
      const publishPresence = (): void => {
        if (!channel) return;
        setPresenceFromState(channel.presenceState() as Parameters<typeof setPresenceFromState>[0]);
      };

      channel
        .on('presence', { event: 'sync' }, publishPresence)
        .on('presence', { event: 'join' }, publishPresence)
        .on('presence', { event: 'leave' }, publishPresence)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'matches' },
          (payload) => {
            const row = payload.new as { id?: string } | null;
            maybeJoin(row?.id ?? null);
          },
        )
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'challenges',
            filter: `target_opponent_id=eq.${userId}`,
          },
          async (payload) => {
            const row = payload.new as {
              id?: string;
              creator_id?: string;
              time_control?: string;
            } | null;
            if (!row?.id) return;
            // Resolve the inviter's display name for the toast.
            let fromName = 'A player';
            if (row.creator_id) {
              const { data: p } = await supabase
                .from('profiles')
                .select('display_name, username')
                .eq('id', row.creator_id)
                .maybeSingle();
              fromName = p?.display_name ?? p?.username ?? fromName;
            }
            setInvite({
              challengeId: row.id,
              fromName,
              timeControl: row.time_control ?? '',
            });
          },
        )
        .subscribe((status) => {
          if (status === 'SUBSCRIBED' && channel) {
            void channel.track({
              user_id: userId,
              display_name: profile?.display_name ?? null,
              username: profile?.username ?? null,
            });
          }
        });

      await ping();
      timer = setInterval(() => void ping(), HEARTBEAT_MS);
    }
    void init();

    function onPageHide(): void {
      // sendBeacon ignores the auth header path but cookies ride along, so the
      // route-handler sees the same auth session.
      try {
        navigator.sendBeacon('/api/practice/challenges/cancel-all');
      } catch {
        /* ignore */
      }
    }
    window.addEventListener('pagehide', onPageHide);

    return () => {
      cancelled = true;
      window.removeEventListener('pagehide', onPageHide);
      if (timer) clearInterval(timer);
      if (channel) void supabase.removeChannel(channel);
      clearPresence();
    };
  }, [router]);

  async function acceptInvite(): Promise<void> {
    if (!invite) return;
    setAccepting(true);
    try {
      const res = await fetch(`/api/practice/challenges/${invite.challengeId}/accept`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? 'accept failed');
      }
      const { matchId } = (await res.json()) as { matchId: string };
      setInvite(null);
      router.push(`/practice/g/${matchId}`);
    } catch {
      // Surface failure by leaving the toast in place; user can try again.
    } finally {
      setAccepting(false);
    }
  }

  // Hide the chip while the user is on the lobby (the inline cards already
  // show their challenge) or in a live game.
  const hideChip =
    openCount === 0 ||
    pathname === '/practice' ||
    pathname.startsWith('/practice/g/') ||
    pathname.startsWith('/practice/create');

  return (
    <>
      {invite && !pathname.startsWith('/practice/g/') && (
        <div className="fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2 rounded-lg border border-accent/40 bg-card/95 p-4 shadow-xl backdrop-blur">
          <p className="text-xs font-semibold uppercase tracking-wider text-accent">
            Direct invite
          </p>
          <p className="text-sm">
            <strong>{invite.fromName}</strong> wants to play{' '}
            {invite.timeControl && <span className="font-mono">{invite.timeControl}</span>}.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void acceptInvite()}
              disabled={accepting}
              className="flex-1 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground disabled:opacity-60"
            >
              {accepting ? 'Joining…' : 'Accept'}
            </button>
            <button
              type="button"
              onClick={() => setInvite(null)}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-xs"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {!hideChip && (
        <Link
          href="/practice"
          className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full border border-accent/40 bg-card/95 px-3 py-1.5 text-xs shadow-lg backdrop-blur hover:bg-card"
        >
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75"></span>
            <span className="relative inline-flex h-2 w-2 rounded-full bg-accent"></span>
          </span>
          <span className="font-medium">
            Waiting for opponent
            {openCount > 1 ? ` (${openCount})` : ''}
          </span>
          <span className="text-muted-foreground">→</span>
        </Link>
      )}
    </>
  );
}
