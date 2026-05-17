/**
 * GET /api/prepare/reports/[id]/pgn — annotated PGN export.
 *
 * Auth: owner OR matching share token in ?t=…
 * Behavior: loads the report's leaks_json (computing it on demand is the
 * caller's job via GET /api/prepare/reports/[id]); if not yet ready,
 * returns 409 with status hint so the UI can poll. Otherwise serializes
 * via apps/web/lib/leaks/pgn-export.ts and streams a .pgn download.
 */
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getPracticeDb } from '@/lib/practice/db';
import { exportReportAsPgn } from '@/lib/leaks/pgn-export';
import type { Leak, Platform } from '@/lib/leaks/types';

interface ReportRow {
  id: string;
  requested_by: string;
  share_token: string | null;
  status: string;
  target_platform: Platform | null;
  target_handle_normalized: string | null;
  leaks_json: { white: Leak[]; black: Leak[]; generated_at: string } | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse | Response> {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'invalid_report_id' }, { status: 400 });
  }

  const sql = getPracticeDb();
  const rows = await sql<ReportRow[]>`
    SELECT id::text, requested_by::text, share_token, status,
           target_platform, target_handle_normalized, leaks_json
    FROM prep_reports
    WHERE id = ${id}::uuid
    LIMIT 1
  `;
  const report = rows[0];
  if (!report) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const url = new URL(req.url);
  const token = url.searchParams.get('t');
  let authorized = false;
  if (token && report.share_token && token === report.share_token) {
    authorized = true;
  }
  if (!authorized) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user && user.id === report.requested_by) {
      authorized = true;
    }
  }
  if (!authorized) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  if (report.status !== 'ready' || report.leaks_json === null) {
    return NextResponse.json({ error: 'not_ready', status: report.status }, { status: 409 });
  }

  const handle = report.target_handle_normalized ?? 'opponent';
  const platform = report.target_platform ?? 'unknown';
  const pgn = exportReportAsPgn({
    reportId: report.id,
    opponentLabel: `${handle} (${platform})`,
    whiteLeaks: report.leaks_json.white,
    blackLeaks: report.leaks_json.black,
    generatedAt: report.leaks_json.generated_at,
  });

  const filename = `chessco-prep-${handle.replace(/[^a-z0-9]+/gi, '-')}-${id.slice(0, 8)}.pgn`;
  return new Response(pgn, {
    status: 200,
    headers: {
      'content-type': 'application/x-chess-pgn; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
    },
  });
}
