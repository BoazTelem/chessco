'use client';

/**
 * SessionGuard — enforces single-active-session per user.
 *
 * /auth/callback writes the new login's `session_id` (from the Supabase JWT)
 * into `user_active_session` and revokes every other refresh token for the
 * user. This component, mounted globally in the root layout, watches that
 * row from any older tab and signs itself out the moment its session is no
 * longer the active one.
 *
 *   1. On mount: read our current access-token session_id and the row's
 *      session_id. If they don't match, sign out immediately. This handles
 *      the stale tab that was already open before the new login.
 *   2. Live: subscribe to Realtime UPDATEs on that row (RLS filters to the
 *      current user). Any change whose new session_id isn't ours triggers
 *      a signOut + redirect.
 *
 * Revoked refresh tokens (admin.signOut(jwt, 'others') in /auth/callback)
 * are the fallback: an old tab that misses the Realtime event still dies
 * the moment its short-lived access token expires (~1 h).
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { getSessionIdFromJwt } from '@/lib/auth/session-jwt';
import type { RealtimeChannel } from '@supabase/supabase-js';

export function SessionGuard() {
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    let channel: RealtimeChannel | null = null;
    let mySessionId: string | null = null;

    async function kick(): Promise<void> {
      if (cancelled) return;
      cancelled = true;
      try {
        await supabase.auth.signOut({ scope: 'local' });
      } catch {
        /* ignore — we redirect either way */
      }
      router.replace('/login?error=session_replaced');
      router.refresh();
    }

    async function init(): Promise<void> {
      const { data: sessionData } = await supabase.auth.getSession();
      const session = sessionData.session;
      if (!session) return;

      mySessionId = getSessionIdFromJwt(session.access_token);
      if (!mySessionId) return;

      const userId = session.user.id;

      // Initial reconciliation: did a newer login happen while this tab
      // was closed / backgrounded?
      const { data: row } = await supabase
        .from('user_active_session')
        .select('session_id')
        .eq('user_id', userId)
        .maybeSingle();

      if (cancelled) return;
      if (row && row.session_id && row.session_id !== mySessionId) {
        void kick();
        return;
      }

      channel = supabase
        .channel(`user-active-session:${userId}`)
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'user_active_session',
            filter: `user_id=eq.${userId}`,
          },
          (payload) => {
            const next = payload.new as { session_id?: string } | null;
            if (!next?.session_id) return;
            if (next.session_id !== mySessionId) void kick();
          },
        )
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'user_active_session',
            filter: `user_id=eq.${userId}`,
          },
          (payload) => {
            const next = payload.new as { session_id?: string } | null;
            if (!next?.session_id) return;
            if (next.session_id !== mySessionId) void kick();
          },
        )
        .subscribe();
    }

    void init();

    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [router]);

  return null;
}
