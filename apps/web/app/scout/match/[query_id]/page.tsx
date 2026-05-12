import Link from 'next/link';
import { notFound } from 'next/navigation';
import { brand } from '@chessco/ui';
import { ChesscoMark } from '@/lib/logo';
import { createClient } from '@/lib/supabase/server';
import { CountryBadge, TitleBadge } from '../../result-card';

export const metadata = {
  title: 'Identification results',
};

interface IdentificationQuery {
  id: string;
  status: 'pending' | 'ready' | 'failed';
  input_method: string | null;
  query_payload: {
    federation_player_id?: string | null;
    name?: string;
    country?: string | null;
    fide_rating?: number | null;
    title?: string | null;
  };
  created_at: string;
  completed_at: string | null;
}

interface Candidate {
  rank: number;
  platform: 'lichess' | 'chess.com';
  handle: string;
  confidence_label: 'high' | 'medium' | 'low';
  combined_score: number;
  federation_player_id: string | null;
  evidence: {
    reasons: string[];
    country: string | null;
    title: string | null;
    ratings: {
      bullet: number | null;
      blitz: number | null;
      rapid: number | null;
      classical: number | null;
    };
  };
  user_confirmed: boolean | null;
}

const PLATFORM_URL: Record<Candidate['platform'], (handle: string) => string> = {
  lichess: (h) => `https://lichess.org/@/${h}`,
  'chess.com': (h) => `https://www.chess.com/member/${h}`,
};

export default async function MatchPage({ params }: { params: Promise<{ query_id: string }> }) {
  const { query_id } = await params;
  const supabase = await createClient();

  const { data: query } = (await supabase
    .from('identification_queries')
    .select('id, status, input_method, query_payload, created_at, completed_at')
    .eq('id', query_id)
    .maybeSingle()) as { data: IdentificationQuery | null };

  if (!query) notFound();

  const { data: candidates } = (await supabase
    .from('identification_candidates')
    .select(
      'rank, platform, handle, confidence_label, combined_score, federation_player_id, evidence, user_confirmed',
    )
    .eq('query_id', query_id)
    .order('rank', { ascending: true })) as { data: Candidate[] | null };

  const subjectName = query.query_payload.name ?? '(unknown subject)';

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
            <span className="text-foreground">Match</span>
          </div>
        </div>
      </header>

      <main className="container mx-auto max-w-3xl px-4 py-10">
        <section>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-accent">
            Online accounts for
          </p>
          <h1 className="mt-1 font-display text-3xl font-bold tracking-tight">{subjectName}</h1>
          <p className="mt-2 text-xs text-muted-foreground">
            Query {query.id.slice(0, 8)}… · status{' '}
            <span
              className={
                query.status === 'ready'
                  ? 'text-emerald-500'
                  : query.status === 'failed'
                    ? 'text-rose-500'
                    : 'text-amber-500'
              }
            >
              {query.status}
            </span>
            {query.input_method && <> · via {query.input_method}</>}
          </p>
        </section>

        {query.status === 'failed' && (
          <section className="mt-8 rounded-lg border border-rose-500/30 bg-rose-500/10 p-5">
            <p className="text-sm">
              This identification run failed. Try again from the player page, or contact support if
              this persists.
            </p>
          </section>
        )}

        {query.status === 'pending' && (
          <section className="mt-8 rounded-lg border border-border bg-card p-5">
            <p className="text-sm">Working on it — refresh in a few seconds.</p>
          </section>
        )}

        {query.status === 'ready' && (!candidates || candidates.length === 0) && (
          <section className="mt-8 rounded-lg border border-border bg-card p-5">
            <p className="text-sm">
              No confident matches in our cached online corpus yet. We&apos;ll keep crawling — try
              again in a few weeks.
            </p>
          </section>
        )}

        {query.status === 'ready' && candidates && candidates.length > 0 && (
          <section className="mt-8 space-y-3">
            <p className="text-xs text-muted-foreground">
              Showing top {candidates.length}. Confidence is computed from handle similarity,
              country, rating-band, and title alignment.
            </p>
            {candidates.map((c) => (
              <CandidateCard key={`${c.platform}-${c.handle}`} c={c} />
            ))}
          </section>
        )}

        <section className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Coming soon
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <PlaceholderCard
              label="Phase 1 W5"
              title="By sample game"
              body="Paste 1+ PGN(s) of the target player and run AI stylometric matching against ~5M cached profiles."
            />
            <PlaceholderCard
              label="Phase 1 W6"
              title="Confirm / reject feedback"
              body="One-click thumbs up / down on each candidate to train the next user's ranking."
            />
          </div>
        </section>
      </main>
    </div>
  );
}

function CandidateCard({ c }: { c: Candidate }) {
  const url = PLATFORM_URL[c.platform](c.handle);
  const labelColor =
    c.confidence_label === 'high'
      ? 'text-emerald-500'
      : c.confidence_label === 'medium'
        ? 'text-amber-500'
        : 'text-muted-foreground';
  const ratings: Array<[string, number | null]> = [
    ['Bullet', c.evidence.ratings.bullet],
    ['Blitz', c.evidence.ratings.blitz],
    ['Rapid', c.evidence.ratings.rapid],
    ['Classical', c.evidence.ratings.classical],
  ];
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <a
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            className="font-display text-xl font-bold tracking-tight hover:text-accent"
          >
            {c.handle}
          </a>
          <p className="mt-0.5 text-xs uppercase tracking-wider text-muted-foreground">
            #{c.rank} · {c.platform}
            {c.evidence.country && ' · '}
            {c.evidence.country && <CountryBadge code={c.evidence.country} />}
            {c.evidence.title && ' · '}
            {c.evidence.title && <TitleBadge title={c.evidence.title} />}
          </p>
        </div>
        <div className="text-right">
          <p className={`font-display text-2xl font-bold tabular-nums ${labelColor}`}>
            {(c.combined_score * 100).toFixed(0)}%
          </p>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {c.confidence_label}
          </p>
        </div>
      </div>

      {ratings.some(([, r]) => r != null) && (
        <div className="mt-3 grid grid-cols-4 gap-2 text-xs">
          {ratings.map(([label, r]) => (
            <div key={label}>
              <p className="text-[10px] uppercase text-muted-foreground">{label}</p>
              <p className="tabular-nums">{r ?? '—'}</p>
            </div>
          ))}
        </div>
      )}

      <ul className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {c.evidence.reasons.map((r) => (
          <li key={r}>· {r}</li>
        ))}
      </ul>
    </div>
  );
}

function PlaceholderCard({ label, title, body }: { label: string; title: string; body: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-accent">{label}</p>
      <p className="mt-1 font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
