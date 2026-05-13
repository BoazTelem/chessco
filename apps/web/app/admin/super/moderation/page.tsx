import { KpiTile } from '../_components/KpiTile';
import { RangeSelector } from '../_components/RangeSelector';
import { SectionCard } from '../_components/SectionCard';
import { formatDateTime, formatNumber } from '../_lib/format';
import { adminDb } from '../_lib/queries';
import { parseRange } from '../_lib/range';
import { banUser, liftBan, resolveReport } from '../_actions';

export const dynamic = 'force-dynamic';

type ReportRow = {
  id: string;
  reporter_email: string | null;
  reported_id: string;
  reported_email: string | null;
  reason: string;
  details: string | null;
  status: string;
  created_at: string;
};

type BanRow = {
  profile_id: string;
  email: string | null;
  reason: string;
  banned_at: string;
  banned_by_email: string | null;
};

type FairplayRow = {
  id: string;
  profile_id: string;
  email: string | null;
  flag_type: string;
  severity: number;
  created_at: string;
};

export default async function ModerationPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { range: rangeParam } = await searchParams;
  const range = parseRange(rangeParam);

  const [openReports, activeBans, fairplayQueue, openCount, banCount, fairplayCount] =
    await Promise.all([
      fetchOpenReports(),
      fetchActiveBans(),
      fetchFairplayQueue(),
      safeCount('user_reports', { status: 'open' }),
      safeCountActiveBans(),
      safeCount('fairplay_flags', { outcome: 'pending' }),
    ]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">Moderation</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            User-to-user reports, bans, and anti-cheat queue.
          </p>
        </div>
        <RangeSelector current={range} basePath="/admin/super/moderation" />
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiTile
          label="Open reports"
          value={formatNumber(openCount)}
          tone={openCount > 0 ? 'warning' : 'positive'}
        />
        <KpiTile
          label="Active bans"
          value={formatNumber(banCount)}
          tone={banCount > 0 ? 'danger' : 'default'}
        />
        <KpiTile
          label="Fairplay flags"
          value={formatNumber(fairplayCount)}
          tone={fairplayCount > 0 ? 'warning' : 'default'}
        />
      </div>

      <SectionCard
        title="Open reports queue"
        subtitle="Payouts to reported users are held until resolved"
      >
        {openReports.length === 0 ? (
          <p className="text-sm text-muted-foreground">Queue is clear.</p>
        ) : (
          <ul className="space-y-3">
            {openReports.map((r) => (
              <li key={r.id} className="rounded border border-border bg-background p-4">
                <header className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">
                      <span className="text-muted-foreground">Reporter:</span>{' '}
                      {r.reporter_email ?? '(system)'}{' '}
                      <span className="text-muted-foreground">→ Reported:</span>{' '}
                      <span className="text-rose-300">{r.reported_email ?? r.reported_id}</span>
                    </p>
                    <p className="mt-1 text-xs uppercase tracking-wider text-accent">
                      {r.reason} · {r.status}
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground">{formatDateTime(r.created_at)}</p>
                </header>
                {r.details && (
                  <p className="mt-2 whitespace-pre-wrap rounded bg-card px-3 py-2 text-xs text-muted-foreground">
                    {r.details}
                  </p>
                )}
                <form
                  action={resolveReport}
                  className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]"
                >
                  <input type="hidden" name="report_id" value={r.id} />
                  <input
                    name="note"
                    placeholder="Resolution note (optional)"
                    className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                  />
                  <select
                    name="action_taken"
                    defaultValue="none"
                    className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                  >
                    <option value="none">No action</option>
                    <option value="warning">Warning</option>
                    <option value="ban">Ban user</option>
                    <option value="payout_forfeit">Forfeit payout</option>
                    <option value="refund_issued">Issue refund</option>
                  </select>
                  <button
                    name="status"
                    value="resolved_valid"
                    className="rounded-md bg-rose-500/20 px-3 py-1 text-xs font-semibold text-rose-200 hover:bg-rose-500/30"
                  >
                    Valid
                  </button>
                  <button
                    name="status"
                    value="resolved_invalid"
                    className="rounded-md bg-emerald-500/20 px-3 py-1 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/30"
                  >
                    Invalid
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Banned users" subtitle="Active bans">
        {activeBans.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active bans.</p>
        ) : (
          <ul className="space-y-2">
            {activeBans.map((b) => (
              <li
                key={b.profile_id}
                className="flex flex-wrap items-center justify-between gap-3 rounded border border-border bg-background px-3 py-2 text-sm"
              >
                <div>
                  <p className="font-medium">{b.email ?? b.profile_id}</p>
                  <p className="text-xs text-muted-foreground">
                    Banned {formatDateTime(b.banned_at)} by {b.banned_by_email ?? 'admin'} ·{' '}
                    {b.reason}
                  </p>
                </div>
                <form action={liftBan} className="flex gap-2">
                  <input type="hidden" name="profile_id" value={b.profile_id} />
                  <input
                    name="reason"
                    placeholder="Reason for lifting"
                    className="rounded-md border border-border bg-card px-2 py-1 text-xs"
                  />
                  <button
                    type="submit"
                    className="rounded-md bg-emerald-500/20 px-3 py-1 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/30"
                  >
                    Lift ban
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="Fairplay flags"
        subtitle="Anti-cheat queue (engine correlation, time patterns, etc.)"
      >
        {fairplayQueue.length === 0 ? (
          <p className="text-sm text-muted-foreground">Queue is clear.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {fairplayQueue.map((f) => (
              <li
                key={f.id}
                className="flex items-center justify-between border-b border-border/40 px-1 py-2"
              >
                <span>
                  <span className="font-medium">{f.email ?? f.profile_id}</span>{' '}
                  <span className="text-muted-foreground">· {f.flag_type}</span>
                </span>
                <span className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span
                    className={`rounded px-1.5 py-0.5 font-medium ${
                      f.severity >= 7
                        ? 'bg-rose-500/15 text-rose-300'
                        : f.severity >= 4
                          ? 'bg-amber-500/15 text-amber-300'
                          : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    sev {f.severity}
                  </span>
                  <span>{formatDateTime(f.created_at)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Manual ban" subtitle="Ban a profile by ID (bypass reports flow)">
        <form action={banUser} className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
          <input
            name="profile_id"
            required
            placeholder="profile UUID"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <input
            name="reason"
            required
            placeholder="Reason (required)"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="rounded-md bg-rose-500/20 px-3 py-2 text-sm font-semibold text-rose-200 hover:bg-rose-500/30"
          >
            Ban
          </button>
        </form>
      </SectionCard>
    </div>
  );
}

async function fetchOpenReports(): Promise<ReportRow[]> {
  const sb = adminDb();
  try {
    const { data } = await sb
      .from('user_reports')
      .select('id,reporter_id,reported_id,reason,details,status,created_at')
      .in('status', ['open', 'investigating'])
      .order('created_at', { ascending: false })
      .limit(50);
    if (!data?.length) return [];

    const ids = [
      ...new Set([
        ...data.map((r) => r.reporter_id).filter(Boolean),
        ...data.map((r) => r.reported_id),
      ]),
    ] as string[];
    const { data: profs } = await sb.from('profiles').select('id,email').in('id', ids);
    const map = new Map((profs ?? []).map((p) => [p.id, p.email as string | null]));
    return data.map((r) => ({
      id: r.id,
      reporter_email: r.reporter_id ? (map.get(r.reporter_id) ?? null) : null,
      reported_id: r.reported_id,
      reported_email: map.get(r.reported_id) ?? null,
      reason: r.reason,
      details: r.details,
      status: r.status,
      created_at: r.created_at,
    }));
  } catch {
    return [];
  }
}

async function fetchActiveBans(): Promise<BanRow[]> {
  const sb = adminDb();
  try {
    const { data } = await sb
      .from('user_bans')
      .select('profile_id,banned_by,reason,banned_at')
      .is('lifted_at', null)
      .order('banned_at', { ascending: false })
      .limit(50);
    if (!data?.length) return [];
    const ids = [...new Set([...data.map((r) => r.profile_id), ...data.map((r) => r.banned_by)])];
    const { data: profs } = await sb.from('profiles').select('id,email').in('id', ids);
    const map = new Map((profs ?? []).map((p) => [p.id, p.email as string | null]));
    return data.map((b) => ({
      profile_id: b.profile_id,
      email: map.get(b.profile_id) ?? null,
      reason: b.reason,
      banned_at: b.banned_at,
      banned_by_email: map.get(b.banned_by) ?? null,
    }));
  } catch {
    return [];
  }
}

async function fetchFairplayQueue(): Promise<FairplayRow[]> {
  const sb = adminDb();
  const { data } = await sb
    .from('fairplay_flags')
    .select('id,profile_id,flag_type,severity,created_at')
    .eq('outcome', 'pending')
    .order('severity', { ascending: false })
    .limit(50);
  if (!data?.length) return [];
  const ids = [...new Set(data.map((r) => r.profile_id))];
  const { data: profs } = await sb.from('profiles').select('id,email').in('id', ids);
  const map = new Map((profs ?? []).map((p) => [p.id, p.email as string | null]));
  return data.map((r) => ({
    id: r.id,
    profile_id: r.profile_id,
    email: map.get(r.profile_id) ?? null,
    flag_type: r.flag_type,
    severity: r.severity,
    created_at: r.created_at,
  }));
}

async function safeCount(table: string, filters: Record<string, unknown>): Promise<number> {
  const sb = adminDb();
  try {
    let q = sb.from(table).select('*', { count: 'exact', head: true });
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    const { count, error } = await q;
    if (error) throw error;
    return count ?? 0;
  } catch {
    return 0;
  }
}

async function safeCountActiveBans(): Promise<number> {
  const sb = adminDb();
  try {
    const { count, error } = await sb
      .from('user_bans')
      .select('*', { count: 'exact', head: true })
      .is('lifted_at', null);
    if (error) throw error;
    return count ?? 0;
  } catch {
    return 0;
  }
}
