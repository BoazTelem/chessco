/**
 * POST /api/practice/heartbeat — bumps `last_heartbeat = NOW()` on every
 * open challenge owned by the caller. The lobby treats a challenge as live
 * only while its heartbeat is fresh (see migration 0027), so the publisher's
 * client must call this every ~20 s while a tab is open.
 *
 * Returns:
 *   - bumped: how many open challenges the caller still has (drives the
 *     "Waiting for opponent" chip)
 *   - latestLiveMatchId: id of the most recent still-live match the caller
 *     is a participant in. Acts as a polling fallback so the publisher gets
 *     auto-routed to their game even if a Realtime postgres_changes event is
 *     dropped (worst case ~20 s lag instead of forever).
 */
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST(): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { data: bumpedRows, error } = await supabase
    .from('challenges')
    .update({ last_heartbeat: new Date().toISOString() })
    .eq('creator_id', user.id)
    .eq('status', 'open')
    .select('id');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Look up any in-flight match this user is in (creator or opponent) so the
  // client can route them in even if Realtime didn't deliver.
  const { data: matchRows } = await supabase
    .from('matches')
    .select('id, accepted_at')
    .or(`creator_id.eq.${user.id},opponent_id.eq.${user.id}`)
    .in('status', ['accepted', 'starting', 'live'])
    .order('accepted_at', { ascending: false })
    .limit(1);

  return NextResponse.json({
    bumped: bumpedRows?.length ?? 0,
    latestLiveMatchId: matchRows?.[0]?.id ?? null,
  });
}
