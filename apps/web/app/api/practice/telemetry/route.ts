/**
 * POST /api/practice/telemetry — record fairplay signals from the live game UI.
 * Best-effort: no error surfaced to the client. Insert via service role
 * because fairplay_telemetry RLS is service-role-only.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

const Input = z.object({
  matchId: z.string().uuid(),
  event: z.enum(['tab_blur', 'tab_focus', 'mouse_idle', 'paste_detected', 'devtools_open']),
  clientTs: z.number().int().optional(),
});

export async function POST(req: Request): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: true }); // silently drop

  let body: z.infer<typeof Input>;
  try {
    body = Input.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: true });
  }

  // Verify participation via the regular client (RLS guards).
  const { data: lg } = await supabase
    .from('live_games')
    .select('white_user_id, black_user_id')
    .eq('match_id', body.matchId)
    .maybeSingle();
  if (!lg || (lg.white_user_id !== user.id && lg.black_user_id !== user.id)) {
    return NextResponse.json({ ok: true });
  }

  try {
    await createAdminClient()
      .from('fairplay_telemetry')
      .insert({
        match_id: body.matchId,
        profile_id: user.id,
        event_type: body.event,
        client_timestamp: body.clientTs ? new Date(body.clientTs).toISOString() : null,
      });
  } catch {
    /* swallow */
  }
  return NextResponse.json({ ok: true });
}
