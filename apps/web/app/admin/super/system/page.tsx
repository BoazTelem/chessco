import { KpiTile } from '../_components/KpiTile';
import { SectionCard } from '../_components/SectionCard';
import { formatDateTime, formatNumber } from '../_lib/format';
import { adminDb } from '../_lib/queries';

export const dynamic = 'force-dynamic';
export const revalidate = 60;

type AuditRow = {
  id: number;
  actor_type: string;
  actor_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  created_at: string;
};

export default async function SystemPage() {
  const [unprocessedStripe, oldestStripeAgeMin, failedTopups, recentAudits, pendingPrep] =
    await Promise.all([
      countStripeUnprocessed(),
      oldestUnprocessedStripeAgeMinutes(),
      countTopupStatus('failed'),
      fetchRecentAudits(),
      countPrepStatus(['pending', 'building']),
    ]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-3xl font-bold tracking-tight">System</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Webhook backlog, queue depth, audit trail.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label="Stripe backlog"
          value={formatNumber(unprocessedStripe)}
          tone={unprocessedStripe > 5 ? 'danger' : 'default'}
          sublabel="unprocessed webhooks"
        />
        <KpiTile
          label="Oldest backlog"
          value={oldestStripeAgeMin === null ? '—' : `${oldestStripeAgeMin} min`}
          tone={oldestStripeAgeMin && oldestStripeAgeMin > 30 ? 'warning' : 'default'}
        />
        <KpiTile
          label="Failed topups"
          value={formatNumber(failedTopups)}
          tone={failedTopups > 0 ? 'warning' : 'default'}
          sublabel="all-time"
        />
        <KpiTile
          label="Prep in flight"
          value={formatNumber(pendingPrep)}
          sublabel="pending or building"
        />
      </div>

      <SectionCard title="Recent admin actions" subtitle="Last 50 audit log entries">
        {recentAudits.length === 0 ? (
          <p className="text-sm text-muted-foreground">No audit entries yet.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {recentAudits.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 px-1 py-1.5"
              >
                <span className="flex items-center gap-2">
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider">
                    {a.actor_type}
                  </span>
                  <span className="text-muted-foreground">{a.actor_email ?? a.actor_type}</span>
                  <span className="font-mono">{a.action}</span>
                  {a.target_type && (
                    <span className="text-muted-foreground">
                      → {a.target_type}:{a.target_id?.slice(0, 8)}
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground">{formatDateTime(a.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

async function countStripeUnprocessed(): Promise<number> {
  const sb = adminDb();
  try {
    const { count } = await sb
      .from('stripe_events')
      .select('*', { count: 'exact', head: true })
      .eq('processed', false);
    return count ?? 0;
  } catch {
    return 0;
  }
}

async function oldestUnprocessedStripeAgeMinutes(): Promise<number | null> {
  const sb = adminDb();
  try {
    const { data } = await sb
      .from('stripe_events')
      .select('received_at')
      .eq('processed', false)
      .order('received_at', { ascending: true })
      .limit(1);
    const first = data?.[0];
    if (!first) return null;
    return Math.round((Date.now() - new Date(first.received_at).getTime()) / 60000);
  } catch {
    return null;
  }
}

async function countTopupStatus(status: string): Promise<number> {
  const sb = adminDb();
  try {
    const { count } = await sb
      .from('topup_intents')
      .select('*', { count: 'exact', head: true })
      .eq('status', status);
    return count ?? 0;
  } catch {
    return 0;
  }
}

async function countPrepStatus(statuses: string[]): Promise<number> {
  const sb = adminDb();
  const { count } = await sb
    .from('prep_reports')
    .select('*', { count: 'exact', head: true })
    .in('status', statuses);
  return count ?? 0;
}

async function fetchRecentAudits(): Promise<AuditRow[]> {
  const sb = adminDb();
  const { data } = await sb
    .from('audit_logs')
    .select('id,actor_type,actor_id,action,target_type,target_id,created_at')
    .order('created_at', { ascending: false })
    .limit(50);
  if (!data?.length) return [];
  const ids = [...new Set(data.map((r) => r.actor_id).filter(Boolean))] as string[];
  const emailMap = new Map<string, string | null>();
  if (ids.length) {
    const { data: profs } = await sb.from('profiles').select('id,email').in('id', ids);
    for (const p of profs ?? []) emailMap.set(p.id, p.email);
  }
  return data.map((r) => ({
    id: r.id,
    actor_type: r.actor_type,
    actor_email: r.actor_id ? (emailMap.get(r.actor_id) ?? null) : null,
    action: r.action,
    target_type: r.target_type,
    target_id: r.target_id,
    created_at: r.created_at,
  }));
}
