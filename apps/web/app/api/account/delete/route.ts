/**
 * POST /api/account/delete — soft-delete the caller's account (GDPR §24
 * right-to-erasure).
 *
 * Body: { confirm: 'DELETE' } — primitive guard against accidental hits.
 *
 * Effect — all PII is cleared synchronously on first call. The row stays
 * (deleted_at IS NOT NULL) so financial/audit references survive. There is
 * no deferred-purge worker on this path; identifiable fields are nulled
 * here and now.
 *   - profiles.deleted_at = NOW()
 *   - display_name, avatar_url, bio, country, city, date_of_birth,
 *     chess_title, last_seen_at, stripe_*_id → NULL
 *   - email rewritten to `deleted-{id}@chessco.local` (frees the unique
 *     index so the original address can be re-registered)
 *   - username rewritten to `deleted-{id}` (frees the unique
 *     index, stays non-null)
 *   - kyc_status → 'none', marketing_consent → false
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

  // Soft-delete + full PII nullification in one transaction; audit-log
  // the action. Fields not nullified: profile_visibility (just a flag),
  // referral_code (NOT NULL UNIQUE — rewritten to sentinel), preferred_language,
  // is_verified. ban_actions are kept (FK is RESTRICT) so this update
  // cannot inadvertently erase moderation history.
  await sql.begin(async (tx) => {
    await tx`
      UPDATE profiles
      SET deleted_at = NOW(),
          display_name = NULL,
          avatar_url = NULL,
          bio = NULL,
          country = NULL,
          city = NULL,
          date_of_birth = NULL,
          chess_title = NULL,
          last_seen_at = NULL,
          stripe_account_id = NULL,
          stripe_customer_id = NULL,
          kyc_status = 'none',
          email = ${`deleted-${user.id}@chessco.local`},
          username = ${`deleted-${user.id}`},
          referral_code = ${`deleted-${user.id}`},
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
    pii_cleared: true,
  });
}
