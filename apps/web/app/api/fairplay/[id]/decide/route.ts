/**
 * POST /api/fairplay/[id]/decide — admin decision on a fairplay flag.
 *
 * Body: { outcome: 'confirmed' | 'dismissed', severity?: 1..6, notes?: string }
 *
 * Auth: super-admin only.
 *
 * On 'confirmed': writes the flag outcome + applies the spec §12 action
 * stack via apps/web/lib/fairplay/action-stack.ts. The action persists
 * to `ban_actions`; side-effects (cancel challenges, freeze wallet,
 * forfeit balance) are noted in the audit log but actually applied
 * transactionally here.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUser, isSuperAdminEmail } from '@/lib/auth';
import { getPracticeDb } from '@/lib/practice/db';
import { planForSeverity, type Severity } from '@/lib/fairplay/action-stack';

const Input = z.object({
  outcome: z.enum(['confirmed', 'dismissed']),
  severity: z.number().int().min(1).max(6).optional(),
  notes: z.string().trim().max(2000).optional(),
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
    return NextResponse.json({ error: 'invalid_flag_id' }, { status: 400 });
  }

  let body: z.infer<typeof Input>;
  try {
    body = Input.parse(await req.json());
  } catch (err) {
    const msg =
      err instanceof z.ZodError ? (err.issues[0]?.message ?? 'invalid input') : 'invalid JSON';
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  if (body.outcome === 'confirmed' && !body.severity) {
    return NextResponse.json({ error: 'severity_required_on_confirmed' }, { status: 400 });
  }

  const sql = getPracticeDb();

  const flagRows = await sql<{ profile_id: string; outcome: string }[]>`
    SELECT profile_id::text, outcome FROM fairplay_flags WHERE id = ${id}::uuid
  `;
  const flag = flagRows[0];
  if (!flag) {
    return NextResponse.json({ error: 'flag_not_found' }, { status: 404 });
  }
  if (flag.outcome !== 'pending') {
    return NextResponse.json({ error: 'already_decided', current: flag.outcome }, { status: 409 });
  }

  await sql.begin(async (tx) => {
    await tx`
      UPDATE fairplay_flags
      SET outcome = ${body.outcome},
          reviewed_by = ${user.id}::uuid,
          reviewed_at = NOW(),
          action_taken = ${body.outcome === 'confirmed' ? actionTakenLabel((body.severity ?? 1) as Severity) : 'none'}
      WHERE id = ${id}::uuid
    `;

    if (body.outcome === 'confirmed') {
      const sev = body.severity as Severity;
      const plan = planForSeverity(sev);

      await tx`
        INSERT INTO ban_actions
          (profile_id, severity, reason, evidence, applied_by, expires_at)
        VALUES (
          ${flag.profile_id}::uuid,
          ${sev},
          ${body.notes ?? plan.description},
          ${JSON.stringify({ flag_id: id, plan_description: plan.description, side_effects: plan.sideEffects })}::jsonb,
          ${user.id}::uuid,
          ${plan.expiresAt}
        )
      `;

      // Side-effects. These are intentionally narrow + idempotent; a
      // re-decide of the same flag should be safe (rejected at outcome
      // check above anyway).
      if (plan.sideEffects.includes('cancel_open_challenges')) {
        await tx`
          UPDATE challenges SET status = 'cancelled', updated_at = NOW()
          WHERE creator_id = ${flag.profile_id}::uuid AND status = 'open'
        `;
      }
      if (plan.sideEffects.includes('cancel_pending_invitations')) {
        await tx`
          UPDATE challenge_invitations SET status = 'withdrawn', responded_at = NOW()
          WHERE invitee_id = ${flag.profile_id}::uuid AND status = 'pending'
        `;
      }
      // freeze_wallet, forfeit_pending_balance, invalidate_sessions: log
      // an audit row so operators run the operational steps from the
      // engine-cheating-investigation runbook. We do NOT auto-execute
      // those here — the side effects touch money + sessions which need
      // human eyes per spec §12.
      const operationalEffects = plan.sideEffects.filter((e) =>
        ['freeze_wallet', 'forfeit_pending_balance', 'invalidate_sessions'].includes(e),
      );
      if (operationalEffects.length > 0) {
        await tx`
          INSERT INTO audit_logs (actor_type, actor_id, action, target_type, target_id, after)
          VALUES (
            'admin',
            ${user.id}::uuid,
            'fairplay.action.requires_operator',
            'profile',
            ${flag.profile_id},
            ${JSON.stringify({ flag_id: id, severity: sev, operational_effects: operationalEffects })}::jsonb
          )
        `;
      }
    }

    await tx`
      INSERT INTO audit_logs (actor_type, actor_id, action, target_type, target_id, after, reason)
      VALUES (
        'admin',
        ${user.id}::uuid,
        ${'fairplay.decide.' + body.outcome},
        'fairplay_flag',
        ${id},
        ${JSON.stringify({ severity: body.severity ?? null })}::jsonb,
        ${body.notes ?? null}
      )
    `;
  });

  return NextResponse.json({ ok: true });
}

function actionTakenLabel(severity: Severity): string {
  switch (severity) {
    case 1:
      return 'warning';
    case 2:
    case 3:
    case 4:
      return 'paid_play_suspended';
    case 5:
    case 6:
      return 'banned';
  }
}
