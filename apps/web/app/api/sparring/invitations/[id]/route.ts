/**
 * PATCH /api/sparring/invitations/[id] resolves a pending invitation without
 * accepting the challenge. Accept uses the existing challenge-accept endpoint
 * so match/live_game creation stays in one place.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUser } from '@/lib/auth';
import { getPracticeDb } from '@/lib/practice/db';

const Input = z.object({
  action: z.enum(['decline']),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'invalid_invitation_id' }, { status: 400 });
  }

  try {
    Input.parse(await req.json());
  } catch (err) {
    const msg =
      err instanceof z.ZodError ? (err.issues[0]?.message ?? 'invalid input') : 'invalid JSON';
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const sql = getPracticeDb();
  const rows = await sql.begin(async (tx) => {
    const updated = await tx<{ id: string; status: string; challenge_id: string }[]>`
      UPDATE challenge_invitations
      SET status = 'declined', responded_at = NOW()
      WHERE id = ${id}::uuid
        AND invitee_id = ${user.id}::uuid
        AND status = 'pending'
      RETURNING id::text, status, challenge_id::text
    `;

    const invitation = updated[0];
    if (invitation) {
      await tx`
        UPDATE challenges
        SET target_opponent_id = NULL, updated_at = NOW()
        WHERE id = ${invitation.challenge_id}::uuid
          AND target_opponent_id = ${user.id}::uuid
          AND status = 'open'
      `;
    }

    return updated;
  });

  if (rows.length === 0) {
    return NextResponse.json({ error: 'not_found_or_already_resolved' }, { status: 404 });
  }

  return NextResponse.json({ invitation_id: rows[0]!.id, status: rows[0]!.status });
}
