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
import { getPracticeDb } from '@/lib/practice/db';

// Only treat a match as "you should be auto-routed into this right now" if it
// was accepted very recently. The fallback poll exists to catch the ~5 s
// window where Realtime might drop the matches INSERT event — anything older
// than this is either a match the user already saw and left, or a stale
// never-settled row from a broken-WS test session. Either way, do NOT yank
// them back into it.
const AUTO_JOIN_WINDOW_MS = 90_000;

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

  // Auto-join candidate: only matches that are (a) freshly accepted and
  // (b) backed by a live_games row still in 'live' state. Joining live_games
  // means a settled/abandoned game won't trigger a redirect even if its
  // matches.status hasn't been flipped yet.
  const sql = getPracticeDb();
  const cutoffIso = new Date(Date.now() - AUTO_JOIN_WINDOW_MS).toISOString();
  const matchRows = (await sql`
    SELECT m.id
    FROM matches m
    JOIN live_games lg ON lg.match_id = m.id
    WHERE (m.creator_id = ${user.id} OR m.opponent_id = ${user.id})
      AND lg.status = 'live'
      AND m.accepted_at > ${cutoffIso}
    ORDER BY m.accepted_at DESC
    LIMIT 1
  `) as Array<{ id: string }>;

  return NextResponse.json({
    bumped: bumpedRows?.length ?? 0,
    latestLiveMatchId: matchRows[0]?.id ?? null,
  });
}
