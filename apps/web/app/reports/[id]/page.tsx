/**
 * GET /reports/[id]?t=<share_token> — interactive prep-report viewer.
 *
 * Spec §7. Owner OR matching share token only. Renders the persisted
 * leaks_json from prep_reports (no on-demand recompute here — that lives
 * in GET /api/prepare/reports/[id]; the operator hits that first or via
 * the /prepare/[platform]/[handle] page on creation).
 *
 * Action buttons live in the ReportActions client island.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getPracticeDb } from '@/lib/practice/db';
import { createClient } from '@/lib/supabase/server';
import type { Leak, Platform } from '@/lib/leaks/types';
import { ReportActions } from './ReportActions';
import { ReadOnlyLeakList } from './ReadOnlyLeakList';

export const dynamic = 'force-dynamic';

interface ReportRow {
  id: string;
  requested_by: string;
  share_token: string | null;
  status: string;
  target_platform: Platform | null;
  target_handle_normalized: string | null;
  leaks_json: { white: Leak[]; black: Leak[]; generated_at: string } | null;
  created_at: string;
  completed_at: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const metadata: Metadata = {
  title: 'Prep report',
  robots: { index: false, follow: false },
};

async function loadReport(id: string): Promise<ReportRow | null> {
  const sql = getPracticeDb();
  const rows = await sql<ReportRow[]>`
    SELECT id::text, requested_by::text, share_token, status,
           target_platform, target_handle_normalized, leaks_json,
           created_at::text, completed_at::text
    FROM prep_reports
    WHERE id = ${id}::uuid
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export default async function ReportViewerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ t?: string }>;
}) {
  const { id } = await params;
  const { t } = await searchParams;
  if (!UUID_RE.test(id)) notFound();

  const report = await loadReport(id);
  if (!report) notFound();

  // Auth: owner OR matching share token.
  let isOwner = false;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user && user.id === report.requested_by) isOwner = true;
  const sharedView = !isOwner && !!t && t === report.share_token;
  if (!isOwner && !sharedView) notFound();

  const handleLabel = report.target_handle_normalized ?? 'opponent';
  const platformLabel = report.target_platform ?? 'unknown platform';

  const whiteLeaks = report.leaks_json?.white ?? [];
  const blackLeaks = report.leaks_json?.black ?? [];
  const totalLeaks = whiteLeaks.length + blackLeaks.length;

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 md:py-12">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Prep report</p>
          <h1 className="mt-1 font-display text-2xl font-semibold md:text-3xl">
            {handleLabel} <span className="text-muted-foreground">on {platformLabel}</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Status: {report.status}
            {report.completed_at ? ` · finished ${report.completed_at.slice(0, 10)}` : null}
            {' · '}
            {totalLeaks} leak{totalLeaks === 1 ? '' : 's'}
          </p>
        </div>
        <ReportActions
          reportId={report.id}
          isOwner={isOwner}
          hasShareToken={!!report.share_token}
          shareToken={sharedView ? t : null}
        />
      </header>

      {sharedView ? (
        <div className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
          You are viewing this report via a share link. The owner can revoke it at any time.
        </div>
      ) : null}

      {report.status !== 'ready' ? (
        <section className="mt-8 rounded-md border border-border bg-card p-6">
          <h2 className="font-display text-lg font-semibold">Report not ready yet</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Build status:{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">{report.status}</code>. Poll{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              GET /api/prepare/reports/{report.id}
            </code>{' '}
            for the substage detail; the leaks rendering on this page hydrates once status is{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">ready</code>.
          </p>
        </section>
      ) : totalLeaks === 0 ? (
        <section className="mt-8 rounded-md border border-border bg-card p-6">
          <h2 className="font-display text-lg font-semibold">No leaks surfaced</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The matcher found no positions where the opponent underperforms reachably from your
            repertoire. Try a different opponent or expand your repertoire coverage.
          </p>
        </section>
      ) : (
        <div className="mt-8 grid gap-8">
          {whiteLeaks.length > 0 ? (
            <section>
              <h2 className="font-display text-lg font-semibold">When you play White</h2>
              <ReadOnlyLeakList leaks={whiteLeaks} />
            </section>
          ) : null}
          {blackLeaks.length > 0 ? (
            <section>
              <h2 className="font-display text-lg font-semibold">When you play Black</h2>
              <ReadOnlyLeakList leaks={blackLeaks} />
            </section>
          ) : null}
        </div>
      )}
    </main>
  );
}
