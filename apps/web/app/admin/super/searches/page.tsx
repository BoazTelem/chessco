import Link from 'next/link';
import { SectionCard } from '../_components/SectionCard';
import { formatDateTime, formatNumber } from '../_lib/format';
import { adminDb } from '../_lib/queries';
import { FiltersBar } from './_components/FiltersBar';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type SearchEventRow = {
  id: string;
  occurred_at: string;
  kind: 'scout_query' | 'prepare_verify' | 'prep_visit' | 'leak_reveal';
  profile_id: string | null;
  search_session_id: string | null;
  ip_hash: string | null;
  ip_geo_city: string | null;
  ip_geo_country: string | null;
  ip_geo_region: string | null;
  query_text: string | null;
  target_platform: 'lichess' | 'chess.com' | null;
  target_handle: string | null;
  result_count: number | null;
  leak_fingerprint: string | null;
  cost_credits: number | null;
  extra: Record<string, unknown> | null;
};

type Row = SearchEventRow & { email: string | null; username: string | null };

interface SearchParams {
  q?: string;
  kind?: string;
  identity?: string;
  profile?: string;
  country?: string;
  session?: string;
  from?: string;
  to?: string;
  page?: string;
}

export default async function SearchesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? '').trim();
  const kind = (sp.kind ?? '').trim();
  const identity = (sp.identity ?? '').trim();
  const profile = (sp.profile ?? '').trim();
  const country = (sp.country ?? '').trim().toUpperCase();
  const session = (sp.session ?? '').trim();
  const from = (sp.from ?? '').trim();
  const to = (sp.to ?? '').trim();
  const page = Math.max(1, Number(sp.page) || 1);
  const validSession = UUID_RE.test(session) ? session : '';
  const validFrom = DATE_RE.test(from) ? from : '';
  const validTo = DATE_RE.test(to) ? to : '';
  const safeQ = sanitizePostgrestOrSearch(q);

  const sb = adminDb();

  // Email filter is a two-step lookup: profiles.ilike(email) -> ids, then
  // search_events.profile_id IN (ids). Keeps the main events query simple
  // and avoids needing a join in PostgREST.
  let allowedProfileIds: string[] | null = null;
  if (profile) {
    const { data: matchingProfiles } = await sb
      .from('profiles')
      .select('id')
      .ilike('email', `%${profile}%`)
      .limit(500);
    allowedProfileIds = (matchingProfiles ?? []).map((p) => p.id);
    if (allowedProfileIds.length === 0) {
      return renderEmpty(q, kind, identity, profile, country, session, from, to, page);
    }
  }

  let eventsQ = sb
    .from('search_events')
    .select(
      'id,occurred_at,kind,profile_id,search_session_id,ip_hash,ip_geo_city,ip_geo_country,ip_geo_region,query_text,target_platform,target_handle,result_count,leak_fingerprint,cost_credits,extra',
      { count: 'exact' },
    )
    .order('occurred_at', { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

  if (kind) eventsQ = eventsQ.eq('kind', kind);
  if (identity === 'signed_in') eventsQ = eventsQ.not('profile_id', 'is', null);
  if (identity === 'anon') eventsQ = eventsQ.is('profile_id', null);
  if (country) eventsQ = eventsQ.eq('ip_geo_country', country);
  if (validSession) eventsQ = eventsQ.eq('search_session_id', validSession);
  if (allowedProfileIds) eventsQ = eventsQ.in('profile_id', allowedProfileIds);
  if (safeQ) eventsQ = eventsQ.or(`query_text.ilike.%${safeQ}%,target_handle.ilike.%${safeQ}%`);
  if (validFrom) eventsQ = eventsQ.gte('occurred_at', `${validFrom}T00:00:00Z`);
  if (validTo) eventsQ = eventsQ.lte('occurred_at', `${validTo}T23:59:59Z`);

  const { data: events, count, error } = await eventsQ;
  if (error) throw error;

  // Resolve profile_id -> email/username via a single follow-up query.
  const profileIds = Array.from(
    new Set((events ?? []).map((e) => e.profile_id).filter((v): v is string => v !== null)),
  );
  const profileById = new Map<string, { email: string | null; username: string | null }>();
  if (profileIds.length > 0) {
    const { data: profiles } = await sb
      .from('profiles')
      .select('id,email,username')
      .in('id', profileIds);
    for (const p of profiles ?? []) {
      profileById.set(p.id, { email: p.email, username: p.username });
    }
  }

  const rows: Row[] = (events ?? []).map((e) => ({
    ...(e as SearchEventRow),
    email: e.profile_id ? (profileById.get(e.profile_id)?.email ?? null) : null,
    username: e.profile_id ? (profileById.get(e.profile_id)?.username ?? null) : null,
  }));

  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">Searches</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatNumber(count ?? 0)} matching events — anon visitors shown by salted IP + Vercel
            geo
          </p>
        </div>
      </header>

      <FiltersBar
        q={q}
        kind={kind}
        identity={identity}
        profile={profile}
        country={country}
        session={session}
        from={from}
        to={to}
      />

      <SectionCard title="Activity feed" subtitle="Most recent first">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-sm">
            <thead className="text-xs uppercase tracking-wider text-muted-foreground">
              <tr className="border-b border-border">
                <Th>Time</Th>
                <Th>Kind</Th>
                <Th>Identity</Th>
                <Th>Query / Target</Th>
                <Th align="right">Result</Th>
                <Th>Session</Th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                    No events match.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border/40">
                  <Td>
                    <span title={r.occurred_at}>{formatDateTime(r.occurred_at)}</span>
                  </Td>
                  <Td>
                    <KindBadge kind={r.kind} />
                  </Td>
                  <Td>{renderIdentity(r)}</Td>
                  <Td>{renderQueryTarget(r)}</Td>
                  <Td align="right">{renderResult(r)}</Td>
                  <Td>{renderSession(r)}</Td>
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
                href={pageUrl({ q, kind, identity, profile, country, session, from, to }, page - 1)}
                className="rounded-md border border-border bg-card px-3 py-1 hover:bg-muted"
              >
                Previous
              </Link>
            )}
            {page < totalPages && (
              <Link
                href={pageUrl({ q, kind, identity, profile, country, session, from, to }, page + 1)}
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

function renderEmpty(
  q: string,
  kind: string,
  identity: string,
  profile: string,
  country: string,
  session: string,
  from: string,
  to: string,
  page: number,
) {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-3xl font-bold tracking-tight">Searches</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          0 matching events — email filter narrowed results to none.
        </p>
      </header>
      <FiltersBar
        q={q}
        kind={kind}
        identity={identity}
        profile={profile}
        country={country}
        session={session}
        from={from}
        to={to}
      />
      <p className="text-sm text-muted-foreground">No profiles match the email filter.</p>
      <p className="text-xs text-muted-foreground">
        Page {page} · clear filters to see all events.
      </p>
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

function KindBadge({ kind }: { kind: Row['kind'] }) {
  const color = {
    scout_query: 'bg-sky-500/15 text-sky-300',
    prepare_verify: 'bg-violet-500/15 text-violet-300',
    prep_visit: 'bg-emerald-500/15 text-emerald-300',
    leak_reveal: 'bg-amber-500/15 text-amber-300',
  }[kind];
  const label = {
    scout_query: 'scout',
    prepare_verify: 'verify',
    prep_visit: 'visit',
    leak_reveal: 'reveal',
  }[kind];
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${color}`}>{label}</span>;
}

function renderIdentity(r: Row): React.ReactNode {
  if (r.profile_id) {
    return (
      <div className="space-y-0.5">
        <p className="font-medium">{r.email ?? r.profile_id.slice(0, 8)}</p>
        {r.username && <p className="text-xs text-muted-foreground">@{r.username}</p>}
      </div>
    );
  }
  const geo = [r.ip_geo_city, r.ip_geo_country].filter(Boolean).join(', ') || '?';
  const ipFp = r.ip_hash ? `#${r.ip_hash.slice(0, 4)}` : '';
  return (
    <span className="text-xs text-muted-foreground">
      anon · {geo} <span className="font-mono">{ipFp}</span>
    </span>
  );
}

function renderQueryTarget(r: Row): React.ReactNode {
  if (r.kind === 'scout_query' || r.kind === 'prepare_verify') {
    return r.query_text ? <code className="text-xs">{r.query_text}</code> : <span>—</span>;
  }
  if (r.target_handle) {
    const platform = r.target_platform ?? '?';
    return (
      <Link
        href={`/prepare/${platform === 'chess.com' ? 'chesscom' : 'lichess'}/${encodeURIComponent(r.target_handle)}`}
        className="text-accent hover:underline"
      >
        {platform}/{r.target_handle}
      </Link>
    );
  }
  return <span>—</span>;
}

function renderResult(r: Row): React.ReactNode {
  if (r.kind === 'leak_reveal') {
    const auto = (r.extra as { auto?: boolean } | null)?.auto === true;
    if (auto) {
      return <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px]">auto-free</span>;
    }
    if (r.cost_credits === 0) {
      return <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px]">free</span>;
    }
    return <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px]">paid</span>;
  }
  if (r.result_count === null) return <span>—</span>;
  return formatNumber(r.result_count);
}

function renderSession(r: Row): React.ReactNode {
  if (!r.search_session_id) return <span>—</span>;
  const short = r.search_session_id.slice(0, 6);
  return (
    <Link
      href={`/admin/super/searches?session=${r.search_session_id}`}
      className="font-mono text-xs text-muted-foreground hover:text-foreground"
      title={r.search_session_id}
    >
      #{short}
    </Link>
  );
}

function pageUrl(
  params: {
    q: string;
    kind: string;
    identity: string;
    profile: string;
    country: string;
    session: string;
    from: string;
    to: string;
  },
  page: number,
): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  if (page > 1) qs.set('page', String(page));
  const s = qs.toString();
  return s ? `/admin/super/searches?${s}` : '/admin/super/searches';
}

function sanitizePostgrestOrSearch(value: string): string {
  return value
    .replace(/[%,()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
