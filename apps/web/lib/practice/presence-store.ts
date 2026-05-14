'use client';

/**
 * Shared client-side store for the `practice-presence` Realtime channel's
 * presence state. PracticePresence owns the channel (mounted globally in the
 * root layout) and writes the latest user list here on every sync/join/leave.
 * Other components (e.g. InvitePicker) read from this store via usePresence()
 * — they must NOT open their own channel with the same topic, because
 * `supabase.channel(topic)` returns the existing already-subscribed instance,
 * and `.on('presence', …)` throws after `.subscribe()`.
 */

import { useSyncExternalStore } from 'react';

export interface PresenceUser {
  user_id: string;
  display_name: string | null;
  username: string | null;
}

type RawPresenceState = Record<
  string,
  Array<{ display_name?: string | null; username?: string | null; presence_ref: string }>
>;

let snapshot: PresenceUser[] = [];
const listeners = new Set<() => void>();
const EMPTY: PresenceUser[] = [];

function emit(): void {
  for (const cb of listeners) cb();
}

export function setPresenceFromState(state: RawPresenceState): void {
  const next: PresenceUser[] = [];
  for (const [userId, metas] of Object.entries(state)) {
    const m = metas[0];
    if (!m) continue;
    next.push({
      user_id: userId,
      display_name: m.display_name ?? null,
      username: m.username ?? null,
    });
  }
  snapshot = next;
  emit();
}

export function clearPresence(): void {
  if (snapshot.length === 0) return;
  snapshot = [];
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): PresenceUser[] {
  return snapshot;
}

function getServerSnapshot(): PresenceUser[] {
  return EMPTY;
}

export function usePresence(): PresenceUser[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
