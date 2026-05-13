import Link from 'next/link';
import { RangeSelector } from '../_components/RangeSelector';
import { SectionCard } from '../_components/SectionCard';
import { formatCents, formatDate, formatNumber, daysAgo } from '../_lib/format';
import { adminDb } from '../_lib/queries';
import { parseRange, rangeStartISO } from '../_lib/range';

export const dynamic = 'force-dynamic';
export const revalidate = 60;

type Row = {
  id: string;
  email: string | null;
  username: string | null;
  country: string | null;
  created_at: string;
  last_seen_at: string | null;
  searches: number;
  preps: number;
  wallet_cents: number;
  deposited_cents: number;
  open_reports: number;
  banned: boolean;
};

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; q?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const range = parseRange(sp.range);
  const q = (sp.q ?? '').trim();
  const page = Math.max(1, Number(sp.page) || 1);
  const pageSize = 50;

  const sb = adminDb();
  const start = rangeStartISO(range);

  let profilesQ = sb
    .from('profiles')
    .select('id,email,username,country,created_at,last_seen_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);
  if (q) profilesQ = profilesQ.or(`email.ilike.%${q}%,username.ilike.%${q}%`);

  const { data: profiles, count, error } = await profilesQ;
  if (error) throw error;

  const ids = (profiles ?? []).map((p) => p.id);
  const rows: Row[] = [];

  if (ids.length) {
    const [searches, preps, wallets, deposits, reports, bans] = await Promise.all([
      countByUser('identification_queries', 'requested_by', ids, start),
      countByUser('prep_reports', 'requested_by', ids, start),
      walletsByProfile(ids),
      depositsByProfile(ids, start),
      openReportsByProfile(ids),
      activeBansByProfile(ids),
    ]);

    for (const p of profiles ?? []) {
      rows.push({
        id: p.id,
        email: p.email,
        username: p.username,
        country: p.country,
        created_at: p.created_at,
        last_seen_at: p.last_seen_at,
        searches: searches.get(p.id) ?? 0,
        preps: preps.get(p.id) ?? 0,
        wallet_cents: wallets.get(p.id) ?? 0,
        deposited_cents: deposits.get(p.id) ?? 0,
        open_reports: reports.get(p.id) ?? 0,
        banned: bans.has(p.id),
      });
    }
  }

  const totalPages = Math.max(1, Math.ceil((count ?? 0) / pageSize));

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">Users</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatNumber(count ?? 0)} total · activity counts within the selected range
          </p>
        </div>
        <RangeSelector current={range} basePath="/admin/super/users" />
      </header>

      <form className="flex gap-2" action="/admin/super/users">
        <input type="hidden" name="range" value={range} />
        <input
          name="q"
          defaultValue={q}
          placeholder="Search by email or username"
          className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
        <button
          type="submit"
          className="rounded-md border border-border bg-card px-3 py-2 text-sm hover:bg-muted"
        >
          Search
        </button>
      </form>

      <SectionCard title="All users" subtitle="Most recent signups first">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="text-xs uppercase tracking-wider text-muted-foreground">
              <tr className="border-b border-border">
                <Th>Email / username</Th>
                <Th>Country</Th>
                <Th>Signed up</Th>
                <Th>Last seen</Th>
                <Th align="right">Searches</Th>
                <Th align="right">Preps</Th>
                <Th align="right">Wallet</Th>
                <Th align="right">Deposited</Th>
                <Th>Flags</Th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">
                    No users match.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border/40">
                  <Td>
                    <div className="space-y-0.5">
                      <p className="font-medium">{r.email ?? '—'}</p>
                      {r.username && <p className="text-xs text-muted-foreground">@{r.username}</p>}
                    </div>
                  </Td>
                  <Td>{r.country ?? '—'}</Td>
                  <Td>{formatDate(r.created_at)}</Td>
                  <Td>
                    <span title={r.last_seen_at ?? ''}>{daysAgo(r.last_seen_at)}</span>
                  </Td>
                  <Td align="right">{formatNumber(r.searches)}</Td>
                  <Td align="right">{formatNumber(r.preps)}</Td>
                  <Td align="right">{formatCents(r.wallet_cents)}</Td>
                  <Td align="right">{formatCents(r.deposited_cents)}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {r.banned && (
                        <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium text-rose-300">
                          BANNED
                        </span>
                      )}
                      {r.open_reports > 0 && (
                        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                          {r.open_reports} report{r.open_reports === 1 ? '' : 's'}
                        </span>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {totalPages > 1 && (
        <nav className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            {page > 1 && (
              <Link
                href={`/admin/super/users?range=${range}&q=${encodeURIComponent(q)}&page=${page - 1}`}
                className="rounded-md border border-border bg-card px-3 py-1 hover:bg-muted"
              >
                Previous
              </Link>
            )}
            {page < totalPages && (
              <Link
                href={`/admin/super/users?range=${range}&q=${encodeURIComponent(q)}&page=${page + 1}`}
                className="rounded-md border border-border bg-card px-3 py-1 hover:bg-muted"
              >
                Next
              </Link>
            )}
          </div>
        </nav>
      )}
    </div>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th className={`px-3 py-2 font-medium ${align === 'right' ? 'text-right' : 'text-left'}`}>
      {children}
    </th>
  );
}

function Td({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <td className={`px-3 py-2 ${align === 'right' ? 'text-right font-mono' : 'text-left'}`}>
      {children}
    </td>
  );
}

async function countByUser(
  table: string,
  column: string,
  ids: string[],
  startISO: string | null,
): Promise<Map<string, number>> {
  const sb = adminDb();
  let q = sb.from(table).select(column).in(column, ids);
  if (startISO) q = q.gte('created_at', startISO);
  const { data } = await q;
  const m = new Map<string, number>();
  for (const r of (data ?? []) as unknown as Record<string, string>[]) {
    const id = r[column];
    if (!id) continue;
    m.set(id, (m.get(id) ?? 0) + 1);
  }
  return m;
}

async function walletsByProfile(ids: string[]): Promise<Map<string, number>> {
  const sb = adminDb();
  const { data } = await sb
    .from('wallets')
    .select('profile_id,available_cents,pending_cents')
    .in('profile_id', ids);
  const m = new Map<string, number>();
  for (const r of data ?? [])
    m.set(r.profile_id, (r.available_cents ?? 0) + (r.pending_cents ?? 0));
  return m;
}

async function depositsByProfile(
  ids: string[],
  startISO: string | null,
): Promise<Map<string, number>> {
  const sb = adminDb();
  const m = new Map<string, number>();
  try {
    let q = sb
      .from('topup_intents')
      .select('profile_id,principal_cents,settled_at,status')
      .eq('status', 'succeeded')
      .in('profile_id', ids);
    if (startISO) q = q.gte('settled_at', startISO);
    const { data } = await q;
    for (const r of data ?? [])
      m.set(r.profile_id, (m.get(r.profile_id) ?? 0) + (r.principal_cents ?? 0));
  } catch {
    // topup_intents may not exist yet
  }
  return m;
}

async function openReportsByProfile(ids: string[]): Promise<Map<string, number>> {
  const sb = adminDb();
  const m = new Map<string, number>();
  try {
    const { data } = await sb
      .from('user_reports')
      .select('reported_id')
      .in('reported_id', ids)
      .in('status', ['open', 'investigating']);
    for (const r of data ?? []) m.set(r.reported_id, (m.get(r.reported_id) ?? 0) + 1);
  } catch {
    // table not yet present
  }
  return m;
}

async function activeBansByProfile(ids: string[]): Promise<Set<string>> {
  const sb = adminDb();
  const s = new Set<string>();
  try {
    const { data } = await sb
      .from('user_bans')
      .select('profile_id')
      .in('profile_id', ids)
      .is('lifted_at', null);
    for (const r of data ?? []) s.add(r.profile_id);
  } catch {
    // table not yet present
  }
  return s;
}
