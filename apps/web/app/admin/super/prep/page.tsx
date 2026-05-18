import { KpiTile } from '../_components/KpiTile';
import { RangeSelector } from '../_components/RangeSelector';
import { SectionCard } from '../_components/SectionCard';
import { formatDate, formatNumber } from '../_lib/format';
import { adminDb, countRowsSince } from '../_lib/queries';
import { parseRange, rangeStartISO, type Range } from '../_lib/range';

export const dynamic = 'force-dynamic';
export const revalidate = 60;

export default async function PrepPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { range: rangeParam } = await searchParams;
  const range = parseRange(rangeParam);

  const [total, ready, failed, building, heavy, topTargets, recent] = await Promise.all([
    countRowsSince('prep_reports', 'created_at', range),
    statusCount('prep_reports', 'ready', range),
    statusCount('prep_reports', 'failed', range),
    statusCount('prep_reports', 'building', range),
    heavyUsers(range),
    topPreppedTargets(range),
    recentReports(range),
  ]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">Prep</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Opening-tree preparations run against opponents.
          </p>
        </div>
        <RangeSelector current={range} basePath="/admin/super/prep" />
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Total (range)" value={formatNumber(total)} />
        <KpiTile label="Ready" value={formatNumber(ready)} tone="positive" />
        <KpiTile label="Building" value={formatNumber(building)} />
        <KpiTile
          label="Failed"
          value={formatNumber(failed)}
          tone={failed > 0 ? 'warning' : 'default'}
        />
      </div>

      <SectionCard title="Heavy users" subtitle="Top 20 by prep count in range">
        {heavy.length === 0 ? (
          <p className="text-sm text-muted-foreground">No prep activity in range.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-3 py-2 text-left font-medium">Email</th>
                <th className="px-3 py-2 text-left font-medium">Username</th>
                <th className="px-3 py-2 text-right font-medium">Preps</th>
                <th className="px-3 py-2 text-right font-medium">Failed</th>
              </tr>
            </thead>
            <tbody>
              {heavy.map((u) => (
                <tr key={u.profile_id} className="border-b border-border/40">
                  <td className="px-3 py-2">{u.email ?? '-'}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {u.username ? `@${u.username}` : '-'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{formatNumber(u.count)}</td>
                  <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                    {formatNumber(u.failed)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>

      <SectionCard title="Top targets" subtitle="Most prepped-against players">
        {topTargets.length === 0 ? (
          <p className="text-sm text-muted-foreground">No data.</p>
        ) : (
          <ul className="space-y-2">
            {topTargets.map((t) => (
              <li
                key={t.target_player_id}
                className="flex items-center justify-between rounded border border-border bg-background px-3 py-2 text-sm"
              >
                <span className="truncate">{t.name ?? t.target_player_id}</span>
                <span className="font-mono">{formatNumber(t.count)}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Recent reports" subtitle="Last 20 prep runs">
        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recent reports.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {recent.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between border-b border-border/40 px-1 py-2"
              >
                <span className="truncate">
                  {r.email ?? '-'} → {r.target_name ?? r.target_player_id}
                </span>
                <span className="flex items-center gap-3">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
                      r.status === 'ready'
                        ? 'bg-emerald-500/15 text-emerald-300'
                        : r.status === 'failed'
                          ? 'bg-rose-500/15 text-rose-300'
                          : 'bg-amber-500/15 text-amber-300'
                    }`}
                  >
                    {r.status}
                  </span>
                  <span className="text-xs text-muted-foreground">{formatDate(r.created_at)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

async function statusCount(table: string, status: string, range: Range): Promise<number> {
  const sb = adminDb();
  const start = rangeStartISO(range);
  let q = sb.from(table).select('*', { count: 'exact', head: true }).eq('status', status);
  if (start) q = q.gte('created_at', start);
  const { count } = await q;
  return count ?? 0;
}

type HeavyUser = {
  profile_id: string;
  email: string | null;
  username: string | null;
  count: number;
  failed: number;
};

async function heavyUsers(range: Range): Promise<HeavyUser[]> {
  const sb = adminDb();
  const start = rangeStartISO(range);
  let q = sb.from('prep_reports').select('requested_by,status');
  if (start) q = q.gte('created_at', start);
  const { data } = await q;
  const m = new Map<string, { count: number; failed: number }>();
  for (const r of data ?? []) {
    const cur = m.get(r.requested_by) ?? { count: 0, failed: 0 };
    cur.count += 1;
    if (r.status === 'failed') cur.failed += 1;
    m.set(r.requested_by, cur);
  }
  const sorted = [...m.entries()]
    .map(
      ([id, v]) =>
        ({
          profile_id: id,
          email: null,
          username: null,
          count: v.count,
          failed: v.failed,
        }) as HeavyUser,
    )
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  if (sorted.length) {
    const { data: profs } = await sb
      .from('profiles')
      .select('id,email,username')
      .in(
        'id',
        sorted.map((s) => s.profile_id),
      );
    const map = new Map((profs ?? []).map((p) => [p.id, p]));
    for (const s of sorted) {
      const p = map.get(s.profile_id);
      if (p) {
        s.email = p.email;
        s.username = p.username;
      }
    }
  }
  return sorted;
}

async function topPreppedTargets(
  range: Range,
): Promise<{ target_player_id: string; name: string | null; count: number }[]> {
  const sb = adminDb();
  const start = rangeStartISO(range);
  let q = sb.from('prep_reports').select('target_player_id');
  if (start) q = q.gte('created_at', start);
  const { data } = await q;
  const m = new Map<string, number>();
  for (const r of data ?? []) m.set(r.target_player_id, (m.get(r.target_player_id) ?? 0) + 1);
  const sorted = [...m.entries()]
    .map(([id, count]) => ({ target_player_id: id, name: null as string | null, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  if (sorted.length) {
    const { data: players } = await sb
      .from('players')
      .select('id,display_name')
      .in(
        'id',
        sorted.map((s) => s.target_player_id),
      );
    const map = new Map((players ?? []).map((p) => [p.id, p.display_name as string | null]));
    for (const s of sorted) s.name = map.get(s.target_player_id) ?? null;
  }
  return sorted;
}

type RecentRow = {
  id: string;
  email: string | null;
  target_player_id: string;
  target_name: string | null;
  status: string;
  created_at: string;
};

async function recentReports(range: Range): Promise<RecentRow[]> {
  const sb = adminDb();
  const start = rangeStartISO(range);
  let q = sb
    .from('prep_reports')
    .select('id,requested_by,target_player_id,status,created_at')
    .order('created_at', { ascending: false })
    .limit(20);
  if (start) q = q.gte('created_at', start);
  const { data } = await q;
  if (!data?.length) return [];

  const userIds = [...new Set(data.map((r) => r.requested_by))];
  const targetIds = [...new Set(data.map((r) => r.target_player_id))];
  const [{ data: profs }, { data: players }] = await Promise.all([
    sb.from('profiles').select('id,email').in('id', userIds),
    sb.from('players').select('id,display_name').in('id', targetIds),
  ]);
  const emailMap = new Map((profs ?? []).map((p) => [p.id, p.email as string | null]));
  const nameMap = new Map((players ?? []).map((p) => [p.id, p.display_name as string | null]));
  return data.map((r) => ({
    id: r.id,
    email: emailMap.get(r.requested_by) ?? null,
    target_player_id: r.target_player_id,
    target_name: nameMap.get(r.target_player_id) ?? null,
    status: r.status,
    created_at: r.created_at,
  }));
}
