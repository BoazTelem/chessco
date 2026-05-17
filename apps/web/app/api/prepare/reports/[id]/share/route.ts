/**
 * POST /api/prepare/reports/[id]/share   — mint or rotate a share token
 * DELETE /api/prepare/reports/[id]/share — revoke the share token
 *
 * Only the report owner can mint/rotate/revoke. The token is the raw uuid
 * (no hashing) so a leaked link is the only attack surface; rotation is
 * cheap and the owner can revoke any time. Spec §7 share controls.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getPracticeDb } from '@/lib/practice/db';

interface ReportOwnership {
  id: string;
  requested_by: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadOwnership(id: string): Promise<ReportOwnership | null> {
  const sql = getPracticeDb();
  const rows = await sql<ReportOwnership[]>`
    SELECT id::text, requested_by::text
    FROM prep_reports
    WHERE id = ${id}::uuid
    LIMIT 1
  `;
  return rows[0] ?? null;
}

type OwnerGuard =
  | { kind: 'ok'; report: ReportOwnership }
  | { kind: 'error'; response: NextResponse };

async function requireOwner(id: string): Promise<OwnerGuard> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      kind: 'error',
      response: NextResponse.json({ error: 'unauthenticated' }, { status: 401 }),
    };
  }
  if (!UUID_RE.test(id)) {
    return {
      kind: 'error',
      response: NextResponse.json({ error: 'invalid_report_id' }, { status: 400 }),
    };
  }
  const report = await loadOwnership(id);
  if (!report) {
    return { kind: 'error', response: NextResponse.json({ error: 'not_found' }, { status: 404 }) };
  }
  if (report.requested_by !== user.id) {
    return { kind: 'error', response: NextResponse.json({ error: 'forbidden' }, { status: 403 }) };
  }
  return { kind: 'ok', report };
}

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  const guard = await requireOwner(id);
  if (guard.kind === 'error') return guard.response;

  const token = randomUUID();
  const sql = getPracticeDb();
  await sql`
    UPDATE prep_reports
    SET share_token = ${token}
    WHERE id = ${id}::uuid
  `;
  return NextResponse.json({ share_token: token, share_path: `/reports/${id}?t=${token}` });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  const guard = await requireOwner(id);
  if (guard.kind === 'error') return guard.response;

  const sql = getPracticeDb();
  await sql`
    UPDATE prep_reports
    SET share_token = NULL
    WHERE id = ${id}::uuid
  `;
  return NextResponse.json({ revoked: true });
}
