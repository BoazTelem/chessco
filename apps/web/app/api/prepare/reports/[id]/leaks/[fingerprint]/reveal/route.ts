/**
 * POST /api/prepare/reports/[id]/leaks/[fingerprint]/reveal — atomic
 * free/paid reveal of a personalized leak. First reveal per
 * (profile, platform, handle) is free; the rest cost 1 credit.
 * Surprise and own-side lines never hit this route (they are always free).
 */
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getPracticeDb } from '@/lib/practice/db';
import { unlockLeak } from '@/lib/leaks/unlock';
import { logSearchEvent } from '@/lib/search-events/log';
import type { Leak, Platform } from '@/lib/leaks/types';

interface ReportRow {
  id: string;
  status: string;
  requested_by: string;
  target_platform: Platform | null;
  target_handle_normalized: string | null;
  leaks_json: { white: Leak[]; black: Leak[]; generated_at: string } | null;
}

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string; fingerprint: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { id, fingerprint } = await ctx.params;
  const sql = getPracticeDb();

  const rows = await sql<ReportRow[]>`
    SELECT id::text, status, requested_by::text,
           target_platform, target_handle_normalized, leaks_json
    FROM prep_reports
    WHERE id = ${id}::uuid
    LIMIT 1
  `;
  const report = rows[0];
  if (!report) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (report.requested_by !== user.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (report.status !== 'ready' || !report.leaks_json) {
    return NextResponse.json({ error: 'report_not_ready' }, { status: 409 });
  }
  if (!report.target_platform || !report.target_handle_normalized) {
    return NextResponse.json({ error: 'invalid_report_state' }, { status: 500 });
  }

  const allLeaks = [...report.leaks_json.white, ...report.leaks_json.black];
  const leak = allLeaks.find((l) => l.fingerprint === fingerprint);
  if (!leak) {
    return NextResponse.json({ error: 'leak_not_found' }, { status: 404 });
  }
  if (leak.kind === 'surprise' || leak.kind === 'own') {
    return NextResponse.json({ error: 'free_lines_do_not_need_reveal' }, { status: 400 });
  }

  const result = await unlockLeak({
    profileId: user.id,
    platform: report.target_platform,
    handleNormalized: report.target_handle_normalized,
    leakFingerprint: fingerprint,
    prepReportId: id,
  });

  if (result.status === 'insufficient_credits') {
    return NextResponse.json({ reason: 'insufficient-credits', need: 1 }, { status: 402 });
  }

  void logSearchEvent({
    kind: 'leak_reveal',
    profileId: user.id,
    targetPlatform: report.target_platform,
    targetHandle: report.target_handle_normalized,
    leakFingerprint: fingerprint,
    costCredits: result.cost,
    extra: { auto: false, leak_kind: leak.kind },
  });

  return NextResponse.json({
    status: 'unlocked',
    cost: result.cost,
    unlock_id: result.unlockId,
    leak,
  });
}
