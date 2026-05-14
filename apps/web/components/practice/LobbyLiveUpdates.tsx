'use client';

/**
 * LobbyLiveUpdates — listens for changes on `challenges` and asks Next to
 * re-render the lobby so cards appear/disappear without a manual refresh.
 * Using router.refresh() reuses the server query (RLS, joins on profiles,
 * time-class/opening filters, heartbeat freshness cutoff) so the client
 * doesn't have to mirror that logic.
 *
 * We subscribe to all event types: INSERTs surface newly published
 * challenges, UPDATEs cover status flips (open → matched) and heartbeat
 * pings, and DELETEs cover creator cancellations. Note that Realtime
 * applies RLS against the new row state, so when a row leaves status='open'
 * non-creator subscribers may not receive the UPDATE — the per-card 409
 * fallback in LobbyCard handles that path.
 *
 * Debounced because a single publish can deliver in <50 ms; if multiple
 * events land near-simultaneously we coalesce them into one refresh.
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'challenges' }, () =>
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
