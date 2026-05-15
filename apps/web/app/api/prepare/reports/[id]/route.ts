/**
 * GET /api/prepare/reports/[id] — status + locked/unlocked leak DTOs.
 *
 * Behavior:
 *   - status 'pending' / 'data_pending' / 'building': returns only status.
 *   - status 'failed': returns status + error_text.
 *   - status 'ready': if leaks_json is null, compute it on-demand from the
 *     games corpus and persist it on the row (one-time cost per report).
 *     Then return leaks with per-fingerprint locked/unlocked flags.
 *
 * Locked leak DTOs omit board/sanPath/recommended-move detail (just opening
 * name + game count). Unlocked leaks include the full detail. Surprise lines
 * are always returned with full detail (they are free).
 */
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getPracticeDb } from '@/lib/practice/db';
import { computeReportLeaks } from '@/lib/leaks/compute';
import type { Leak, Platform } from '@/lib/leaks/types';

interface ReportRow {
  id: string;
  status: string;
  requested_by: string;
  target_platform: Platform | null;
  target_handle_normalized: string | null;
  leaks_json: { white: Leak[]; black: Leak[]; generated_at: string } | null;
  error_text: string | null;
}

interface UnlockRow {
  leak_fingerprint: string;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { id } = await ctx.params;
  const sql = getPracticeDb();

  const rows = await sql<ReportRow[]>`
    SELECT id::text, status, requested_by::text,
           target_platform, target_handle_normalized,
           leaks_json, error_text
    FROM prep_reports
    WHERE id = ${id}::uuid
    LIMIT 1
  `;
  const report = rows[0];
  if (!report) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (report.requested_by !== user.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  if (
    report.status === 'pending' ||
    report.status === 'data_pending' ||
    report.status === 'building'
  ) {
    return NextResponse.json({ status: report.status });
  }
  if (report.status === 'failed') {
    return NextResponse.json({ status: 'failed', error: report.error_text });
  }
  if (report.status !== 'ready') {
    return NextResponse.json({ status: report.status });
  }

  if (!report.target_platform || !report.target_handle_normalized) {
    return NextResponse.json({ error: 'invalid_report_state' }, { status: 500 });
  }

  // Compute leaks on first read for a ready report. On any compute error,
  // persist an empty payload so the frontend stops polling — better UX than
  // an infinite "Preparing your report…" spinner on a transient 500.
  let leaks = report.leaks_json;
  if (!leaks) {
    try {
      leaks = await computeReportLeaks({
        profileId: user.id,
        targetPlatform: report.target_platform,
        targetHandleNormalized: report.target_handle_normalized,
      });
    } catch (err) {
      console.error('[GET /api/prepare/reports/:id] compute failed:', err);
      leaks = { white: [], black: [], generated_at: new Date().toISOString() };
    }
    try {
      await sql`
        UPDATE prep_reports
        SET leaks_json = ${JSON.stringify(leaks)}::jsonb
        WHERE id = ${id}::uuid
      `;
    } catch (writeErr) {
      console.error('[GET /api/prepare/reports/:id] persist leaks failed:', writeErr);
    }
  }

  const unlocks = await sql<UnlockRow[]>`
    SELECT leak_fingerprint FROM prep_leak_unlocks
    WHERE profile_id = ${user.id}::uuid
      AND target_platform = ${report.target_platform}
      AND target_handle_normalized = ${report.target_handle_normalized}
  `;
  const unlockedFingerprints = new Set(unlocks.map((u) => u.leak_fingerprint));

  const dto = (leak: Leak) => {
    const isUnlocked = leak.kind === 'surprise' || unlockedFingerprints.has(leak.fingerprint);
    if (isUnlocked) {
      return { ...leak, locked: false as const };
    }
    return {
      fingerprint: leak.fingerprint,
      kind: leak.kind,
      locked: true as const,
      stats: {
        gamesCount: leak.stats.gamesCount,
        userReach: leak.stats.userReach,
        opponentReach: leak.stats.opponentReach,
      },
    };
  };

  return NextResponse.json({
    status: 'ready',
    generated_at: leaks.generated_at,
    leaks: {
      white: leaks.white.map(dto),
      black: leaks.black.map(dto),
    },
  });
}
