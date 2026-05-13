'use client';

/**
 * LobbyLiveUpdates — listens for INSERTs on `challenges` and asks Next to
 * re-render the lobby so newly published cards appear without a manual
 * refresh. Using router.refresh() reuses the server query (RLS, joins on
 * profiles, time-class/opening filters, heartbeat freshness cutoff) so the
 * client doesn't have to mirror that logic.
 *
 * Debounced because a single publish can deliver in <50 ms; if multiple
 * publishes land near-simultaneously we coalesce them into one refresh.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import type { RealtimeChannel } from '@supabase/supabase-js';

const REFRESH_DEBOUNCE_MS = 400;

export function LobbyLiveUpdates() {
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();
    let pending: ReturnType<typeof setTimeout> | null = null;
    let channel: RealtimeChannel | null = null;

    function scheduleRefresh(): void {
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        router.refresh();
      }, REFRESH_DEBOUNCE_MS);
    }

    channel = supabase
      .channel('practice-lobby-live')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'challenges' }, () =>
        scheduleRefresh(),
      )
      .subscribe();

    return () => {
      if (pending) clearTimeout(pending);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [router]);

  return null;
}
