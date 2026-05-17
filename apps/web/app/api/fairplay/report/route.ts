/**
 * POST /api/fairplay/report — player-initiated fairplay report.
 *
 * Body: { match_id: uuid, reported_profile_id: uuid, reason: string, detail?: string }
 *
 * Auth: authenticated. The reporter must have been a participant in the
 * match (creator or opponent). Reports create a fairplay_flags row with
 * flag_type='manual_report' and severity 1 (warning territory) — the
 * engine-correlation worker may raise severity later when it re-analyzes.
 *
 * Anti-abuse: 5 reports per user per 24h, enforced via audit_logs lookup.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUser } from '@/lib/auth';
import { getPracticeDb } from '@/lib/practice/db';

const Input = z.object({
  match_id: z.string().uuid(),
  reported_profile_id: z.string().uuid(),
  reason: z.enum(['engine_assist', 'sandbagging', 'harassment', 'cheating_other']),
  detail: z.string().trim().max(500).optional(),
});

const DAILY_REPORT_CAP = 5;

export async function POST(req: Request): Promise<NextResponse> {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  let body: z.infer<typeof Input>;
  try {
    body = Input.parse(await req.json());
  } catch (err) {
    const msg =
      err instanceof z.ZodError ? (err.issues[0]?.message ?? 'invalid input') : 'invalid JSON';
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  if (body.reported_profile_id === user.id) {
    return NextResponse.json({ error: 'cannot_report_self' }, { status: 400 });
  }

  const sql = getPracticeDb();

  // Verify the reporter participated in the match.
  const matchRows = await sql<{ creator_id: string; opponent_id: string }[]>`
    SELECT creator_id::text, opponent_id::text
    FROM matches WHERE id = ${body.match_id}::uuid
  `;
  const match = matchRows[0];
  if (!match) {
    return NextResponse.json({ error: 'match_not_found' }, { status: 404 });
  }
  if (match.creator_id !== user.id && match.opponent_id !== user.id) {
    return NextResponse.json({ error: 'not_a_participant' }, { status: 403 });
  }
  if (
    match.creator_id !== body.reported_profile_id &&
    match.opponent_id !== body.reported_profile_id
  ) {
    return NextResponse.json({ error: 'reported_profile_not_in_match' }, { status: 400 });
  }

  // Anti-abuse: limit reports per reporter per 24h.
  const recentRows = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM audit_logs
    WHERE actor_id = ${user.id}::uuid
      AND action = 'fairplay.report'
      AND created_at > NOW() - INTERVAL '24 hours'
  `;
  const recent = Number(recentRows[0]?.count ?? 0);
  if (recent >= DAILY_REPORT_CAP) {
    return NextResponse.json({ error: 'rate_limited', cap: DAILY_REPORT_CAP }, { status: 429 });
  }

  const flagRows = await sql<{ id: string }[]>`
    INSERT INTO fairplay_flags
      (profile_id, match_id, flag_type, severity, signals, outcome)
    VALUES
      (${body.reported_profile_id}::uuid,
       ${body.match_id}::uuid,
       'manual_report',
       1,
       ${JSON.stringify({ reason: body.reason, detail: body.detail ?? null, reporter_id: user.id })}::jsonb,
       'pending')
    RETURNING id::text
  `;

  await sql`
    INSERT INTO audit_logs (actor_type, actor_id, action, target_type, target_id, after)
    VALUES (
      'user',
      ${user.id}::uuid,
      'fairplay.report',
      'fairplay_flag',
      ${flagRows[0]!.id},
      ${JSON.stringify({ reason: body.reason, match_id: body.match_id, reported_profile_id: body.reported_profile_id })}::jsonb
    )
  `;

  return NextResponse.json({ flag_id: flagRows[0]!.id });
}
