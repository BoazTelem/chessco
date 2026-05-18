import { KpiTile } from '../_components/KpiTile';
import { RangeSelector } from '../_components/RangeSelector';
import { SectionCard } from '../_components/SectionCard';
import { formatCents, formatDate, formatNumber } from '../_lib/format';
import { adminDb, sumLedger } from '../_lib/queries';
import { parseRange, rangeStartISO, type Range } from '../_lib/range';

export const dynamic = 'force-dynamic';
export const revalidate = 60;

export default async function RevenuePage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { range: rangeParam } = await searchParams;
  const range = parseRange(rangeParam);
  const start = rangeStartISO(range);

  const [
    feeRevenue,
    grossDeposits,
    refundsIssued,
    legacyMatchFees,
    pendingTopups,
    failedTopups,
    unprocessedStripe,
    topSpenders,
    pendingRefunds,
  ] = await Promise.all([
    sumLedger('topup_fee', 'platform_revenue', range),
    sumLedger('deposit', 'user_wallet', range),
    sumLedger('refund', 'user_wallet', range),
    sumLedger('platform_fee', 'platform_revenue', range),
    safeCount('topup_intents', { status: 'pending' }),
    safeCount('topup_intents', { status: 'failed' }, start),
    safeCount('stripe_events', { processed: false }),
    fetchTopSpenders(range),
    fetchPendingRefunds(range),
  ]);

  const netRevenue = feeRevenue + legacyMatchFees - refundsIssued;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">Revenue</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Deposit-side 15% fee. Match settlements pay 100% to opponents.
          </p>
        </div>
        <RangeSelector current={range} basePath="/admin/super/revenue" />
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label="Net revenue (range)"
          value={formatCents(netRevenue)}
          sublabel="fees − refunds"
          tone="positive"
        />
        <KpiTile label="Topup fees" value={formatCents(feeRevenue)} sublabel="deposit-side 15%" />
        <KpiTile
          label="Refunds issued"
          value={formatCents(refundsIssued)}
          tone={refundsIssued > 0 ? 'warning' : 'default'}
        />
        <KpiTile
          label="Gross deposits"
          value={formatCents(grossDeposits)}
          sublabel="principal credited"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiTile
          label="Pending topups"
          value={formatNumber(pendingTopups)}
          tone={pendingTopups > 0 ? 'warning' : 'default'}
          sublabel="awaiting Stripe webhook"
        />
        <KpiTile
          label="Failed topups (range)"
          value={formatNumber(failedTopups)}
          tone={failedTopups > 0 ? 'warning' : 'default'}
        />
        <KpiTile
          label="Unprocessed Stripe events"
          value={formatNumber(unprocessedStripe)}
          tone={unprocessedStripe > 5 ? 'danger' : 'default'}
          sublabel="webhook backlog"
        />
      </div>

      <SectionCard title="Top spenders" subtitle="Most deposited principal in range">
        {topSpenders.length === 0 ? (
          <p className="text-sm text-muted-foreground">No topups in range.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-3 py-2 text-left font-medium">Email</th>
                <th className="px-3 py-2 text-right font-medium">Topups</th>
                <th className="px-3 py-2 text-right font-medium">Principal</th>
                <th className="px-3 py-2 text-right font-medium">Fees paid</th>
              </tr>
            </thead>
            <tbody>
              {topSpenders.map((s) => (
                <tr key={s.profile_id} className="border-b border-border/40">
                  <td className="px-3 py-2">{s.email ?? '-'}</td>
                  <td className="px-3 py-2 text-right font-mono">{formatNumber(s.count)}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {formatCents(s.principal_cents)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{formatCents(s.fee_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>

      <SectionCard title="Open refund requests" subtitle="Awaiting admin review">
        {pendingRefunds.length === 0 ? (
          <p className="text-sm text-muted-foreground">Queue is clear.</p>
        ) : (
          <ul className="space-y-2">
            {pendingRefunds.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between rounded border border-border bg-background px-3 py-2 text-sm"
              >
                <div>
                  <p className="font-medium">{r.reason_code}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatCents(r.amount_cents)} · filed {formatDate(r.created_at)}
                  </p>
                </div>
                <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-300">
                  {r.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

async function safeCount(
  table: string,
  filters: Record<string, unknown>,
  sinceISO?: string | null,
): Promise<number> {
  const sb = adminDb();
  try {
    let q = sb.from(table).select('*', { count: 'exact', head: true });
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    if (sinceISO) q = q.gte('created_at', sinceISO);
    const { count, error } = await q;
    if (error) throw error;
    return count ?? 0;
  } catch {
    return 0;
  }
}

type Spender = {
  profile_id: string;
  email: string | null;
  count: number;
  principal_cents: number;
  fee_cents: number;
};

async function fetchTopSpenders(range: Range): Promise<Spender[]> {
  const sb = adminDb();
  const start = rangeStartISO(range);
  try {
    let q = sb
      .from('topup_intents')
      .select('profile_id,principal_cents,fee_cents,status,settled_at')
      .eq('status', 'succeeded');
    if (start) q = q.gte('settled_at', start);
    const { data, error } = await q;
    if (error) throw error;

    const m = new Map<string, Spender>();
    for (const r of data ?? []) {
      const cur = m.get(r.profile_id) ?? {
        profile_id: r.profile_id,
        email: null,
        count: 0,
        principal_cents: 0,
        fee_cents: 0,
      };
      cur.count += 1;
      cur.principal_cents += r.principal_cents ?? 0;
      cur.fee_cents += r.fee_cents ?? 0;
      m.set(r.profile_id, cur);
    }
    const sorted = [...m.values()]
      .sort((a, b) => b.principal_cents - a.principal_cents)
      .slice(0, 20);

    if (sorted.length) {
      const { data: profs } = await sb
        .from('profiles')
        .select('id,email')
        .in(
          'id',
          sorted.map((s) => s.profile_id),
        );
      const emailMap = new Map((profs ?? []).map((p) => [p.id, p.email]));
      for (const s of sorted) s.email = emailMap.get(s.profile_id) ?? null;
    }
    return sorted;
  } catch {
    return [];
  }
}

type RefundRow = {
  id: string;
  reason_code: string;
  amount_cents: number;
  status: string;
  created_at: string;
};

async function fetchPendingRefunds(range: Range): Promise<RefundRow[]> {
  const sb = adminDb();
  const start = rangeStartISO(range);
  let q = sb
    .from('refund_requests')
    .select('id,reason_code,amount_cents,status,created_at')
    .in('status', ['open', 'under_review'])
    .order('created_at', { ascending: false })
    .limit(20);
  if (start) q = q.gte('created_at', start);
  const { data } = await q;
  return data ?? [];
}
