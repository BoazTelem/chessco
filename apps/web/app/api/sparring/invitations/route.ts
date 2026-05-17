/**
 * POST /api/sparring/invitations — create a private-challenge invitation.
 *
 * Body: { challenge_id: uuid, invitee_id: uuid, message?: string, expires_in_hours?: number }
 *
 * Authorization:
 *   - Caller must be the challenge's creator.
 *   - Invitee must have opted into sparring (player_sparring_profiles.opted_in = true).
 *   - Cannot invite yourself.
 *
 * Idempotency: a unique pending invitation per (challenge, invitee) is
 * enforced by the partial unique index in migration 0042 and by
 * ON CONFLICT below, so concurrent requests return the same invitation.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUser } from '@/lib/auth';
import { getPracticeDb } from '@/lib/practice/db';
import { createNotification } from '@/lib/notifications';

const Input = z.object({
  challenge_id: z.string().uuid(),
  invitee_id: z.string().uuid(),
  message: z.string().trim().max(280).optional(),
  expires_in_hours: z
    .number()
    .int()
    .min(1)
    .max(24 * 14)
    .optional(),
});

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

  if (body.invitee_id === user.id) {
    return NextResponse.json({ error: 'cannot_invite_self' }, { status: 400 });
  }

  const sql = getPracticeDb();

  // Validate ownership of the challenge.
  const challengeRows = await sql<
    { creator_id: string; status: string; target_opponent_id: string | null }[]
  >`
    SELECT creator_id::text, status, target_opponent_id::text
    FROM challenges
    WHERE id = ${body.challenge_id}::uuid
  `;
  const challenge = challengeRows[0];
  if (!challenge) {
    return NextResponse.json({ error: 'challenge_not_found' }, { status: 404 });
  }
  if (challenge.creator_id !== user.id) {
    return NextResponse.json({ error: 'not_creator' }, { status: 403 });
  }
  if (challenge.status !== 'open') {
    return NextResponse.json(
      { error: 'challenge_not_open', detail: `status=${challenge.status}` },
      { status: 409 },
    );
  }
  if (challenge.target_opponent_id && challenge.target_opponent_id !== body.invitee_id) {
    return NextResponse.json({ error: 'challenge_already_targeted' }, { status: 409 });
  }

  // Invitee must have opted in.
  const inviteeRows = await sql<{ opted_in: boolean }[]>`
    SELECT opted_in FROM player_sparring_profiles WHERE profile_id = ${body.invitee_id}::uuid
  `;
  const invitee = inviteeRows[0];
  if (!invitee || !invitee.opted_in) {
    return NextResponse.json({ error: 'invitee_not_opted_in' }, { status: 403 });
  }

  // Dedup: existing pending invitation for the same (challenge, invitee).
  const existing = await sql<{ id: string }[]>`
    SELECT id::text FROM challenge_invitations
    WHERE challenge_id = ${body.challenge_id}::uuid
      AND invitee_id = ${body.invitee_id}::uuid
      AND status = 'pending'
    LIMIT 1
  `;
  if (existing.length > 0) {
    return NextResponse.json({ invitation_id: existing[0]!.id, deduped: true });
  }

  const hours = body.expires_in_hours ?? 72;
  const created = await sql.begin(async (tx) => {
    // Direct invitations should not remain visible in the public lobby.
    await tx`
      UPDATE challenges
      SET target_opponent_id = ${body.invitee_id}::uuid
      WHERE id = ${body.challenge_id}::uuid
        AND (target_opponent_id IS NULL OR target_opponent_id = ${body.invitee_id}::uuid)
    `;
    const inserted = await tx<{ id: string }[]>`
      INSERT INTO challenge_invitations
        (challenge_id, inviter_id, invitee_id, message, expires_at)
      VALUES
        (${body.challenge_id}::uuid,
         ${user.id}::uuid,
         ${body.invitee_id}::uuid,
         ${body.message ?? null},
         NOW() + (${hours}::int * INTERVAL '1 hour'))
      ON CONFLICT (challenge_id, invitee_id) WHERE status = 'pending'
      DO NOTHING
      RETURNING id::text
    `;
    if (inserted.length > 0) {
      await createNotification(
        {
          profileId: body.invitee_id,
          type: 'invitation.received',
          category: 'social',
          title: 'You received a sparring invitation',
          body: body.message ?? undefined,
          data: {
            challenge_id: body.challenge_id,
            invitation_id: inserted[0]!.id,
            inviter_id: user.id,
          },
          actionUrl: '/inbox/invitations',
        },
        tx,
      );
      return { id: inserted[0]!.id, deduped: false };
    }

    const existingAfterConflict = await tx<{ id: string }[]>`
      SELECT id::text
      FROM challenge_invitations
      WHERE challenge_id = ${body.challenge_id}::uuid
        AND invitee_id = ${body.invitee_id}::uuid
        AND status = 'pending'
      LIMIT 1
    `;
    return { id: existingAfterConflict[0]?.id ?? null, deduped: true };
  });

  if (!created.id) {
    return NextResponse.json({ error: 'invitation_conflict_retry' }, { status: 409 });
  }

  return NextResponse.json({ invitation_id: created.id, deduped: created.deduped });
}
