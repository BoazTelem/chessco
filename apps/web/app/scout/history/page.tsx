import Link from 'next/link';
import { brand } from '@chessco/ui';
import { ChesscoMark } from '@/lib/logo';
import { requireUser } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';

export const metadata = {
  title: 'Scout history',
};

interface HistoryRow {
  id: string;
  status: 'pending' | 'ready' | 'failed';
  input_method: string | null;
  query_payload: {
    name?: string;
    games_pasted?: number;
    federation_player_id?: string | null;
    ad_hoc_player_id?: string | null;
  };
  created_at: string;
}

export default async function ScoutHistoryPage() {
  const user = await requireUser();
  const supabase = await createClient();

  const { data: rows } = (await supabase
    .from('identification_queries')
    .select('id, status, input_method, query_payload, created_at')
    .eq('requested_by', user.id)
    .order('created_at', { ascending: false })
    .limit(100)) as { data: HistoryRow[] | null };

  const history = rows ?? [];

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-card/50">
        <div className="container mx-auto flex items-center justify-between px-4 py-4">
          <div className="flex items-center gap-2 text-sm">
            <Link
              href="/"
              aria-label={brand.name}
              className="inline-flex items-center gap-2 hover:opacity-80"
            >
              <ChesscoMark className="h-4 w-4 shrink-0" />
              <span className="font-display font-semibold uppercase tracking-[0.3em] text-accent">
                {brand.name}
              </span>
            </Link>
            <span className="text-muted-foreground">/</span>
            <Link href="/scout" className="text-muted-foreground hover:text-foreground">
              Scout
            </Link>
            <span className="text-muted-foreground">/</span>
            <span className="text-foreground">History</span>
          </div>
        </div>
      </header>

      <main className="container mx-auto max-w-3xl px-4 py-10">
        <section>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-accent">
            Your scout history
          </p>
          <h1 className="mt-1 font-display text-3xl font-bold tracking-tight">Past scouts</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Every player search and PGN paste you&apos;ve run. Click through to revisit the results.
          </p>
        </section>

        {history.length === 0 ? (
          <section className="mt-8 rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
            No scouts yet.{' '}
            <Link href="/scout" className="text-accent hover:underline">
              Start one now →
            </Link>
          </section>
        ) : (
          <ul className="mt-8 space-y-2">
            {history.map((r) => (
              <li key={r.id}>
                <HistoryItem row={r} />
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

function HistoryItem({ row }: { row: HistoryRow }) {
  const subject =
    row.query_payload.name ??
    (row.query_payload.games_pasted
      ? `AI match · ${row.query_payload.games_pasted} pasted games`
      : 'Unknown subject');
  const isPgn = row.input_method === 'sample_game';
  const dateLabel = new Date(row.created_at).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const statusColor =
    row.status === 'ready'
      ? 'text-emerald-500'
      : row.status === 'failed'
        ? 'text-rose-500'
        : 'text-amber-500';

  return (
    <Link
      href={`/scout/match/${row.id}`}
      className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 transition hover:border-accent/50 hover:bg-muted/30"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate font-medium text-foreground">{subject}</p>
          {isPgn && (
            <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent">
              PGN
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {dateLabel} · <span className={statusColor}>{row.status}</span>
          {row.input_method && row.input_method !== 'sample_game' && <> · via {row.input_method}</>}
        </p>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">→</span>
    </Link>
  );
}
