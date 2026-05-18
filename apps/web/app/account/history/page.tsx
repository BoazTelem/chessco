import Link from 'next/link';
import { requireUser } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';

export const metadata = {
  title: 'History',
};

export default async function HistoryPage() {
  const user = await requireUser();
  const supabase = await createClient();

  // Three parallel reads.
  const [gamesRes, searchesRes, prepsRes] = await Promise.all([
    supabase
      .from('live_games')
      .select(
        'match_id, status, result, termination, completed_at, started_at, time_control, initial_fen, white_user_id, black_user_id',
      )
      .or(`white_user_id.eq.${user.id},black_user_id.eq.${user.id}`)
      .order('started_at', { ascending: false })
      .limit(20),
    supabase
      .from('identification_queries')
      .select('id, query_payload, status, created_at')
      .eq('requested_by', user.id)
      .order('created_at', { ascending: false })
      .limit(20),
    supabase
      .from('prep_reports')
      .select('id, status, summary, created_at, completed_at, target_player_id')
      .eq('requested_by', user.id)
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  const games = gamesRes.data ?? [];
  const searches = searchesRes.data ?? [];
  const preps = prepsRes.data ?? [];

  return (
    <div className="container mx-auto max-w-3xl space-y-10 px-4 py-12">
      <header className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">Account</p>
        <h1 className="font-display text-3xl font-bold tracking-tight">History</h1>
        <p className="text-xs text-muted-foreground">
          <Link href="/account" className="hover:underline">
            ← Back to account
          </Link>
        </p>
      </header>

      <Section title="Practice games" count={games.length}>
        {games.length === 0 ? (
          <Empty>
            No games yet.{' '}
            <Link href="/practice" className="text-accent hover:underline">
              browse the lobby
            </Link>
            .
          </Empty>
        ) : (
          <ul className="space-y-2">
            {games.map((g) => {
              const you = g.white_user_id === user.id ? 'white' : 'black';
              return (
                <li key={g.match_id} className="rounded-md border border-border bg-card p-3">
                  <div className="flex items-center justify-between text-sm">
                    <div>
                      <p>
                        <Link
                          href={
                            g.status === 'live'
                              ? `/practice/g/${g.match_id}`
                              : `/practice/g/${g.match_id}/review`
                          }
                          className="hover:text-accent hover:underline"
                        >
                          {g.result ?? '-'} as {you}
                        </Link>
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {g.time_control} · {g.termination ?? g.status}
                      </p>
                    </div>
                    <span className="text-[11px] text-muted-foreground">
                      {fmtDate(g.completed_at ?? g.started_at)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Scout searches" count={searches.length}>
        {searches.length === 0 ? (
          <Empty>
            No searches yet.{' '}
            <Link href="/scout" className="text-accent hover:underline">
              try Scout
            </Link>
            .
          </Empty>
        ) : (
          <ul className="space-y-2">
            {searches.map((s) => {
              const q = (s.query_payload as { q?: string; country?: string } | null) ?? {};
              return (
                <li key={s.id} className="rounded-md border border-border bg-card p-3 text-sm">
                  <p>
                    <Link
                      href={`/scout/match/${s.id}`}
                      className="hover:text-accent hover:underline"
                    >
                      {q.q || '(no name)'} {q.country ? `· ${q.country}` : ''}
                    </Link>
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {s.status} · {fmtDate(s.created_at)}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Preparation reports" count={preps.length}>
        {preps.length === 0 ? (
          <Empty>
            No prep reports yet.{' '}
            <Link href="/prepare" className="text-accent hover:underline">
              try Prepare
            </Link>
            .
          </Empty>
        ) : (
          <ul className="space-y-2">
            {preps.map((r) => (
              <li key={r.id} className="rounded-md border border-border bg-card p-3 text-sm">
                <p>{r.summary ?? `Report ${r.id.slice(0, 8)}`}</p>
                <p className="text-[11px] text-muted-foreground">
                  {r.status} · {fmtDate(r.completed_at ?? r.created_at)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        {title} {count > 0 && <span className="text-foreground">({count})</span>}
      </h2>
      {children}
    </section>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-border bg-card/50 p-4 text-sm text-muted-foreground">
      {children}
    </p>
  );
}
function fmtDate(s: string | null): string {
  if (!s) return '';
  try {
    return new Date(s).toLocaleString();
  } catch {
    return s;
  }
}
