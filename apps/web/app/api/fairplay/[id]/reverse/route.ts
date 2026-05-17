/**
 * POST /api/fairplay/[id]/reverse — admin reversal of a ban_actions row.
 *
 * Body: { reason: string (10..2000 chars) }
 *
 * Auth: super-admin only. The [id] param is a `ban_actions.id`, not a
 * fairplay_flag id (the reversal target is the ban record itself —
 * unlike /decide which operates on the flag).
 *
 * Effect (in one tx):
 *   - ban_actions.reversed_at = NOW(), reversed_by = caller
 *   - audit_logs row 'fairplay.ban.reversed' with the reason
 *
 * Idempotent: replays on an already-reversed ban return 409.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUser, isSuperAdminEmail } from '@/lib/auth';
import { getPracticeDb } from '@/lib/practice/db';

const Input = z.object({
  reason: z.string().trim().min(10).max(2000),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!isSuperAdminEmail(user.email)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'invalid_ban_id' }, { status: 400 });
  }

  let body: z.infer<typeof Input>;
  try {
    body = Input.parse(await req.json());
  } catch (err) {
    const msg =
      err instanceof z.ZodError ? (err.issues[0]?.message ?? 'invalid input') : 'invalid JSON';
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const sql = getPracticeDb();

  const banRows = await sql<{ profile_id: string; severity: number; reversed_at: string | null }[]>`
    SELECT profile_id::text, severity, reversed_at::text
    FROM ban_actions
    WHERE id = ${id}::uuid
  `;
  const ban = banRows[0];
  if (!ban) {
    return NextResponse.json({ error: 'ban_not_found' }, { status: 404 });
  }
  if (ban.reversed_at) {
    return NextResponse.json(
      { error: 'already_reversed', reversed_at: ban.reversed_at },
      { status: 409 },
    );
  }

  await sql.begin(async (tx) => {
    await tx`
      UPDATE ban_actions
      SET reversed_at = NOW(),
          reversed_by = ${user.id}::uuid
      WHERE id = ${id}::uuid
        AND reversed_at IS NULL
    `;
    await tx`
      INSERT INTO audit_logs (actor_type, actor_id, action, target_type, target_id, after, reason)
      VALUES (
        'admin',
        ${user.id}::uuid,
        'fairplay.ban.reversed',
        'ban_action',
        ${id},
        ${JSON.stringify({ profile_id: ban.profile_id, severity: ban.severity })}::jsonb,
        ${body.reason}
      )
    `;
  });

  return NextResponse.json({ ok: true, reversed_at: new Date().toISOString() });
}
