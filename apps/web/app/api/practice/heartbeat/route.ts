/**
 * POST /api/practice/heartbeat — bumps `last_heartbeat = NOW()` on every
 * open challenge owned by the caller. The lobby treats a challenge as live
 * only while its heartbeat is fresh (see migration 0027), so the publisher's
 * client must call this every ~20 s while a tab is open.
 *
 * Returns { bumped } so the client can render "Waiting" only when there's
 * at least one row to wait on.
 */
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST(): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { data, error } = await supabase
    .from('challenges')
    .update({ last_heartbeat: new Date().toISOString() })
    .eq('creator_id', user.id)
    .eq('status', 'open')
    .select('id');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ bumped: data?.length ?? 0 });
}
