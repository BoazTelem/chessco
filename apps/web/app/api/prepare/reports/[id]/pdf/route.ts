/**
 * GET /api/prepare/reports/[id]/pdf — Playwright-rendered PDF (spec §7).
 *
 * Why not render inline: Playwright headed browsers + ~150 MB binaries
 * don't belong in the Next.js runtime — every cold Vercel invocation
 * would pay the boot cost. Instead we hand off to a separate renderer
 * service (Cloud Run worker shipping playwright-extra; see
 * apps/workers/Dockerfile.* for the deploy shape).
 *
 * Operator wires the renderer URL into PREP_PDF_RENDERER_URL. The
 * service POSTs back the rendered PDF bytes; we stream the response.
 * Without the env var set we return 503 with the renderer contract so
 * the operator knows exactly what's missing.
 *
 * Auth: same shape as the PGN endpoint — owner OR share token.
 */
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getPracticeDb } from '@/lib/practice/db';

interface ReportRow {
  id: string;
  requested_by: string;
  share_token: string | null;
  status: string;
  pdf_url: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RENDERER_TIMEOUT_MS = 30_000;

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
    SELECT id::text, requested_by::text, share_token, status, pdf_url
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

  if (report.status !== 'ready') {
    return NextResponse.json({ error: 'not_ready', status: report.status }, { status: 409 });
  }

  // Fast path: a previously rendered PDF was cached on the row.
  if (report.pdf_url) {
    return NextResponse.redirect(report.pdf_url, 302);
  }

  const rendererUrl = process.env.PREP_PDF_RENDERER_URL;
  if (!rendererUrl) {
    return NextResponse.json(
      {
        error: 'renderer_not_configured',
        message:
          'Set PREP_PDF_RENDERER_URL to the Cloud Run renderer endpoint. ' +
          'It must accept POST { report_id, share_token } and return the PDF bytes.',
      },
      { status: 503 },
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDERER_TIMEOUT_MS);
  let renderResp: Response;
  try {
    renderResp = await fetch(rendererUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        report_id: report.id,
        share_token: report.share_token,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'renderer_unreachable',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }
  if (!renderResp.ok) {
    return NextResponse.json(
      {
        error: 'renderer_failed',
        upstream_status: renderResp.status,
      },
      { status: 502 },
    );
  }

  const filename = `chessco-prep-${id.slice(0, 8)}.pdf`;
  return new Response(renderResp.body, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
    },
  });
}
