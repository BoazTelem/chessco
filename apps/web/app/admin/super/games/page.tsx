import { KpiTile } from '../_components/KpiTile';
import { RangeSelector } from '../_components/RangeSelector';
import { SectionCard } from '../_components/SectionCard';
import { TrendChart, type TrendPoint } from '../_components/TrendChart';
import { formatCents, formatNumber } from '../_lib/format';
import { adminDb, countRowsSince, dailyCount } from '../_lib/queries';
import { parseRange, rangeStartISO, type Range } from '../_lib/range';

export const dynamic = 'force-dynamic';
export const revalidate = 60;

export default async function GamesPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { range: rangeParam } = await searchParams;
  const range = parseRange(rangeParam);

  const [
    challengesPublished,
    challengesOpen,
    matchesPlayed,
    matchesSettled,
    challengeStatusCounts,
    matchStatusCounts,
    avgFee,
    escrowLocked,
    topFens,
    matchesDaily,
  ] = await Promise.all([
    countRowsSince('challenges', 'created_at', range),
    statusCount('challenges', 'open'),
    countRowsSince('matches', 'accepted_at', range),
    statusCount('matches', 'settled'),
    countByStatus('challenges'),
    countByStatus('matches'),
    avgMatchFee(range),
    sumEscrowLocked(),
    topPublishedFens(range, 10),
    matchesDailySeries(range),
  ]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">Games</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Challenges published and matches played from those positions.
          </p>
        </div>
        <RangeSelector current={range} basePath="/admin/super/games" />
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Challenges (range)" value={formatNumber(challengesPublished)} />
        <KpiTile label="Open challenges" value={formatNumber(challengesOpen)} />
        <KpiTile label="Matches played (range)" value={formatNumber(matchesPlayed)} />
        <KpiTile
          label="Matches settled (all)"
          value={formatNumber(matchesSettled)}
          tone="positive"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <KpiTile
          label="Avg match fee"
          value={formatCents(avgFee)}
          sublabel="completed matches in range"
        />
        <KpiTile
          label="Escrow currently locked"
          value={formatCents(escrowLocked)}
          sublabel="all live + accepted matches"
        />
      </div>

      <SectionCard title="Matches per day" subtitle="By accepted_at">
        <TrendChart
          data={matchesDaily}
          series={[{ key: 'Matches', label: 'Matches', color: '#A78BFA' }]}
        />
      </SectionCard>

      <div className="grid gap-4 md:grid-cols-2">
        <SectionCard title="Challenge status">
          <ul className="space-y-1 text-sm">
            {challengeStatusCounts.map((s) => (
              <li key={s.status} className="flex justify-between">
                <span className="text-muted-foreground">{s.status}</span>
                <span className="font-mono">{formatNumber(s.count)}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
        <SectionCard title="Match status">
          <ul className="space-y-1 text-sm">
            {matchStatusCounts.map((s) => (
              <li key={s.status} className="flex justify-between">
                <span className="text-muted-foreground">{s.status}</span>
                <span className="font-mono">{formatNumber(s.count)}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      </div>

      <SectionCard
        title="Top published positions (FEN)"
        subtitle="Most-published challenge positions in range"
      >
        {topFens.length === 0 ? (
          <p className="text-sm text-muted-foreground">No challenges in range.</p>
        ) : (
          <ul className="space-y-2">
            {topFens.map((row) => (
              <li
                key={row.fen}
                className="flex items-center justify-between gap-3 rounded border border-border bg-background px-3 py-2"
              >
                <code className="truncate text-xs">{row.fen}</code>
                <span className="font-mono text-sm">{formatNumber(row.count)}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

async function statusCount(table: string, status: string): Promise<number> {
  const sb = adminDb();
  const { count } = await sb
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('status', status);
  return count ?? 0;
}

async function countByStatus(table: string): Promise<{ status: string; count: number }[]> {
  const sb = adminDb();
  const { data } = await sb.from(table).select('status');
  const m = new Map<string, number>();
  for (const r of data ?? []) m.set(r.status, (m.get(r.status) ?? 0) + 1);
  return [...m.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);
}

async function avgMatchFee(range: Range): Promise<number> {
  const sb = adminDb();
  const start = rangeStartISO(range);
  let q = sb.from('matches').select('fee_cents');
  if (start) q = q.gte('accepted_at', start);
  const { data } = await q;
  if (!data || !data.length) return 0;
  const total = data.reduce((a, r) => a + (r.fee_cents ?? 0), 0);
  return Math.round(total / data.length);
}

async function sumEscrowLocked(): Promise<number> {
  const sb = adminDb();
  const { data } = await sb
    .from('matches')
    .select('fee_cents')
    .in('status', ['accepted', 'starting', 'live', 'completed']);
  return (data ?? []).reduce((a, r) => a + (r.fee_cents ?? 0), 0);
}

async function topPublishedFens(
  range: Range,
  limit: number,
): Promise<{ fen: string; count: number }[]> {
  const sb = adminDb();
  const start = rangeStartISO(range);
  let q = sb.from('challenges').select('fen');
  if (start) q = q.gte('created_at', start);
  const { data } = await q;
  const m = new Map<string, number>();
  for (const r of data ?? []) {
    if (!r.fen) continue;
    m.set(r.fen, (m.get(r.fen) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([fen, count]) => ({ fen, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

async function matchesDailySeries(range: Range): Promise<TrendPoint[]> {
  const daily = await dailyCount('matches', 'accepted_at', range);
  return daily.map((d) => ({ date: d.date, Matches: d.count }));
}
