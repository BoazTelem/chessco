/**
 * POST /api/practice/matches/[id]/ticket — mint a short-lived WS handshake
 * ticket. The caller must be one of the two match participants. Returns
 * { url, ticket, role } so the client can open a WebSocket to the realtime
 * server.
 */
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getPracticeDb } from '@/lib/practice/db';
import { signTicket, type TicketRole } from '@/lib/practice/ws-ticket';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: matchId } = await ctx.params;
  if (!/^[a-f0-9-]{36}$/i.test(matchId)) {
    return NextResponse.json({ error: 'invalid match id' }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const sql = getPracticeDb();
  const rows = (await sql`
    SELECT lg.white_user_id, lg.black_user_id, lg.status
    FROM live_games lg
    WHERE lg.match_id = ${matchId}
    LIMIT 1
  `) as Array<{ white_user_id: string; black_user_id: string; status: string }>;
  const row = rows[0];
  if (!row) return NextResponse.json({ error: 'match not found' }, { status: 404 });
  if (row.status !== 'live') {
    return NextResponse.json({ error: 'game is no longer live' }, { status: 409 });
  }

  let role: TicketRole;
  if (row.white_user_id === user.id) role = 'white';
  else if (row.black_user_id === user.id) role = 'black';
  else return NextResponse.json({ error: 'not a participant' }, { status: 403 });

  const ticket = signTicket({ matchId, userId: user.id, role });
  const wsBase = process.env.NEXT_PUBLIC_PRACTICE_WS_URL || 'ws://localhost:3001';
  const url = `${wsBase}/game/${matchId}?ticket=${encodeURIComponent(ticket)}`;

  return NextResponse.json({ url, ticket, role });
}
