import { KpiTile } from './_components/KpiTile';
import { RangeSelector } from './_components/RangeSelector';
import { SectionCard } from './_components/SectionCard';
import { TrendChart, type TrendPoint } from './_components/TrendChart';
import { formatCents, formatNumber, formatPercent } from './_lib/format';
import {
  adminDb,
  countDistinctActiveUsers,
  countRowsSince,
  dailyCount,
  funnel,
  sumLedger,
  totalWalletLiability,
} from './_lib/queries';
import { parseRange, rangeStartISO, type Range } from './_lib/range';

export const dynamic = 'force-dynamic';
export const revalidate = 60;

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { range: rangeParam } = await searchParams;
  const range = parseRange(rangeParam);

  const [
    totalSignups,
    rangeSignups,
    payingUsers,
    activeUsers,
    feeRevenue,
    grossRevenue,
    walletLiability,
    signupDaily,
    revenueDaily,
    funnelStages,
  ] = await Promise.all([
    countRowsSince('profiles', 'created_at', 'all'),
    countRowsSince('profiles', 'created_at', range),
    payingUserCount(range),
    countDistinctActiveUsers(range),
    sumLedger('topup_fee', 'platform_revenue', range),
    sumLedger('deposit', 'user_wallet', range),
    totalWalletLiability(),
    dailyCount('profiles', 'created_at', range),
    revenueDailySeries(range),
    funnel(range),
  ]);

  const signupTrend: TrendPoint[] = signupDaily.map((d) => ({
    date: d.date,
    Signups: d.count,
  }));

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">Overview</h1>
          <p className="mt-1 text-sm text-muted-foreground">Operational pulse of the platform.</p>
        </div>
        <RangeSelector current={range} basePath="/admin/super" />
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label="Total signups"
          value={formatNumber(totalSignups)}
          sublabel={`+${formatNumber(rangeSignups)} in range`}
        />
        <KpiTile
          label="Paying users"
          value={formatNumber(payingUsers)}
          sublabel={`${formatPercent(payingUsers, totalSignups)} of signups`}
          tone="positive"
        />
        <KpiTile
          label="Active in range"
          value={formatNumber(activeUsers)}
          sublabel="distinct last_seen_at"
        />
        <KpiTile
          label="Platform revenue"
          value={formatCents(feeRevenue)}
          sublabel={`gross deposits: ${formatCents(grossRevenue)}`}
          tone="positive"
        />
      </div>

      <SectionCard title="Signups" subtitle="New profile rows by day">
        <TrendChart
          data={signupTrend}
          series={[{ key: 'Signups', label: 'Signups', color: '#F59E0B' }]}
        />
      </SectionCard>

      <SectionCard title="Revenue" subtitle="Deposit principal vs. platform fee (15% on topup)">
        <TrendChart
          data={revenueDaily}
          series={[
            { key: 'Principal', label: 'Deposit principal', color: '#60A5FA' },
            { key: 'Fee', label: 'Platform fee', color: '#F59E0B' },
          ]}
          valueFormat="cents"
        />
      </SectionCard>

      <SectionCard title="Funnel" subtitle="Distinct users reaching each stage (in range)">
        <ol className="space-y-2">
          {funnelStages.map((stage, i) => {
            const prev = i === 0 ? stage.count : (funnelStages[i - 1]?.count ?? 0);
            const pct = i === 0 ? 100 : prev ? (stage.count / prev) * 100 : 0;
            const firstCount = funnelStages[0]?.count ?? 0;
            const totalPct = firstCount ? (stage.count / firstCount) * 100 : 0;
            return (
              <li
                key={stage.label}
                className="flex items-center gap-3 rounded border border-border bg-background px-3 py-2"
              >
                <span className="w-6 text-xs text-muted-foreground">{i + 1}</span>
                <span className="flex-1 text-sm">{stage.label}</span>
                <span className="font-mono text-sm">{formatNumber(stage.count)}</span>
                <span className="w-16 text-right text-xs text-muted-foreground">
                  {i === 0 ? '—' : `${pct.toFixed(0)}% step`}
                </span>
                <span className="w-20 text-right text-xs text-muted-foreground">
                  {totalPct.toFixed(0)}% overall
                </span>
              </li>
            );
          })}
        </ol>
      </SectionCard>

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiTile
          label="Wallet liability"
          value={formatCents(walletLiability)}
          sublabel="sum(available + pending)"
        />
        <KpiTile
          label="Range gross deposits"
          value={formatCents(grossRevenue)}
          sublabel="principal credited to wallets"
        />
        <KpiTile
          label="Fee take rate"
          value={grossRevenue ? `${((feeRevenue / grossRevenue) * 100).toFixed(1)}%` : '—'}
          sublabel="fee / principal"
        />
      </div>
    </div>
  );
}

async function payingUserCount(range: Range): Promise<number> {
  const sb = adminDb();
  const start = rangeStartISO(range);
  try {
    let q = sb.from('topup_intents').select('profile_id').eq('status', 'succeeded');
    if (start) q = q.gte('settled_at', start);
    const { data, error } = await q;
    if (error) throw error;
    return new Set((data ?? []).map((r) => r.profile_id)).size;
  } catch {
    return 0;
  }
}

async function revenueDailySeries(range: Range): Promise<TrendPoint[]> {
  const sb = adminDb();
  const start = rangeStartISO(range);
  let q = sb
    .from('ledger_entries')
    .select('amount_cents,category,created_at')
    .in('category', ['deposit', 'topup_fee']);
  if (start) q = q.gte('created_at', start);
  const { data, error } = await q;
  if (error) throw error;

  const buckets = new Map<string, { principal: number; fee: number }>();
  for (const row of data ?? []) {
    if (!row.created_at) continue;
    const k = new Date(row.created_at).toISOString().slice(0, 10);
    const b = buckets.get(k) ?? { principal: 0, fee: 0 };
    if (row.category === 'deposit') b.principal += row.amount_cents ?? 0;
    else if (row.category === 'topup_fee') b.fee += row.amount_cents ?? 0;
    buckets.set(k, b);
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const startDate = start ? new Date(start) : today;
  startDate.setUTCHours(0, 0, 0, 0);

  const out: TrendPoint[] = [];
  for (let d = new Date(startDate); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    const k = d.toISOString().slice(0, 10);
    const b = buckets.get(k) ?? { principal: 0, fee: 0 };
    out.push({ date: k.slice(5), Principal: b.principal, Fee: b.fee });
  }
  return out;
}
