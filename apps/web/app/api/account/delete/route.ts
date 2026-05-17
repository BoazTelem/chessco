/**
 * POST /api/account/delete — soft-delete the caller's account (GDPR §24
 * right-to-erasure).
 *
 * Body: { confirm: 'DELETE' } — primitive guard against accidental hits.
 *
 * Effect:
 *   - profiles.deleted_at = NOW(), display_name/avatar/bio cleared
 *   - email rewritten to `deleted-{id}@chessco.local` so the unique index
 *     stays valid and the original email can be re-registered.
 *   - 30-day purge: a background worker (not in scope for this WS) reads
 *     profiles.deleted_at and hard-deletes after the retention window so
 *     the financial ledger remains queryable until clear of disputes.
 *
 * Idempotent: replays on an already-deleted account return 200.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUser } from '@/lib/auth';
import { getPracticeDb } from '@/lib/practice/db';

const Input = z.object({
  confirm: z.literal('DELETE'),
});

export async function POST(req: Request): Promise<NextResponse> {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  try {
    Input.parse(await req.json());
  } catch (err) {
    const msg =
      err instanceof z.ZodError ? (err.issues[0]?.message ?? 'invalid input') : 'invalid JSON';
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const sql = getPracticeDb();

  const existingRows = await sql<{ deleted_at: string | null }[]>`
    SELECT deleted_at::text FROM profiles WHERE id = ${user.id}::uuid
  `;
  const existing = existingRows[0];
  if (!existing) {
    return NextResponse.json({ error: 'profile_not_found' }, { status: 404 });
  }
  if (existing.deleted_at) {
    return NextResponse.json({ already_deleted: true, deleted_at: existing.deleted_at });
  }

  // Soft-delete in one transaction; audit-log the action.
  await sql.begin(async (tx) => {
    await tx`
      UPDATE profiles
      SET deleted_at = NOW(),
          display_name = NULL,
          avatar_url = NULL,
          bio = NULL,
          email = ${`deleted-${user.id}@chessco.local`},
          marketing_consent = false,
          updated_at = NOW()
      WHERE id = ${user.id}::uuid
    `;
    await tx`
      INSERT INTO audit_logs (actor_type, actor_id, action, target_type, target_id, reason)
      VALUES ('user', ${user.id}::uuid, 'account.delete', 'profile', ${user.id}, 'user_request')
    `;
  });

  return NextResponse.json({
    deleted: true,
    deleted_at: new Date().toISOString(),
    purge_after_days: 30,
  });
}
