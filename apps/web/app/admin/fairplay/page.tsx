/**
 * /admin/fairplay: the fairplay review queue. Spec §12.
 *
 * Renders pending fairplay_flags sorted by severity desc, with a one-line
 * summary per row and a link to the per-flag decision page (lands when
 * the full review UI ships; for now the row exposes the raw signals
 * payload so an admin reviewer has enough to triage).
 *
 * Auth: super-admin only.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getUser, isSuperAdminEmail } from '@/lib/auth';
import { getPracticeDb } from '@/lib/practice/db';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Fairplay queue · Admin',
  robots: { index: false, follow: false },
};

interface FlagRow {
  id: string;
  profile_id: string;
  profile_name: string | null;
  match_id: string | null;
  flag_type: string;
  severity: number;
  signals: unknown;
  created_at: string;
}

async function loadPending(): Promise<FlagRow[]> {
  const sql = getPracticeDb();
  return sql<FlagRow[]>`
    SELECT fp.id::text,
           fp.profile_id::text,
           p.display_name AS profile_name,
           fp.match_id::text,
           fp.flag_type,
           fp.severity,
           fp.signals,
           fp.created_at::text
    FROM fairplay_flags fp
    JOIN profiles p ON p.id = fp.profile_id
    WHERE fp.outcome = 'pending'
    ORDER BY fp.severity DESC, fp.created_at ASC
    LIMIT 100
  `;
}

export default async function AdminFairplayPage() {
  const user = await getUser();
  if (!user) redirect('/login?next=/admin/fairplay');
  if (!isSuperAdminEmail(user.email)) redirect('/');

  const flags = await loadPending();

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <header>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Admin</p>
        <h1 className="mt-1 font-display text-2xl font-semibold md:text-3xl">Fairplay queue</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Pending flags sorted by severity. SLA: 72 hours. False-positive target &lt; 2%.
        </p>
      </header>

      {flags.length === 0 ? (
        <p className="mt-8 rounded-md border border-dashed border-border bg-card p-6 text-sm text-muted-foreground">
          Queue empty. Either everyone is clean today or the analyzers haven&apos;t fired yet.
        </p>
      ) : (
        <ul className="mt-6 grid gap-3">
          {flags.map((f) => (
            <li key={f.id} className="rounded-lg border border-border bg-card p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <p className="font-semibold">
                    {f.profile_name ?? 'unnamed'}{' '}
                    <span className="text-xs font-normal text-muted-foreground">
                      {f.profile_id.slice(0, 8)}…
                    </span>
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    severity {f.severity} · {f.flag_type} ·{' '}
                    {f.created_at.slice(0, 16).replace('T', ' ')}
                    {f.match_id ? ` · match ${f.match_id.slice(0, 8)}…` : ''}
                  </p>
                </div>
                <span className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
                  Review UI pending
                </span>
              </div>
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-muted-foreground">Signals</summary>
                <pre className="mt-2 overflow-x-auto rounded bg-muted/40 p-2 text-[11px] leading-snug">
                  {JSON.stringify(f.signals, null, 2)}
                </pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
