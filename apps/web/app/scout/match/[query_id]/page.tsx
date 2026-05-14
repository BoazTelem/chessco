import { Fragment } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { brand } from '@chessco/ui';
import { ChesscoMark } from '@/lib/logo';
import { getUser } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { CountryBadge, TitleBadge } from '../../result-card';
import { SampleGameForm } from '../../sample-game-form';
import { ConfirmButtons } from './confirm-buttons';
import { enrichCandidateProfiles } from '@/lib/scout/enrich-candidate-profiles';

export const metadata = {
  title: 'Identification results',
};

interface AiVerdict {
  /** "platform/handle" key of the LLM's chosen best match. */
  best_match: string;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

interface IdentificationQuery {
  id: string;
  status: 'pending' | 'ready' | 'failed';
  input_method: string | null;
  query_payload: {
    federation_player_id?: string | null;
    ad_hoc_player_id?: string | null;
    name?: string;
    country?: string | null;
    fide_rating?: number | null;
    title?: string | null;
    /** When the query was a pure sample-game paste with no FIDE anchor. */
    games_pasted?: number;
    /** Set by /api/identify when LLM rerank produced a verdict. */
    ai_verdict?: AiVerdict | null;
  };
  created_at: string;
  completed_at: string | null;
}

interface Candidate {
  id: number;
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
    /** Claude Haiku one-sentence explanation. Null until LLM enrichment ran
     *  (missing ANTHROPIC_API_KEY, API failure, etc.). UI falls back to the
     *  bullet `reasons` when null. */
    prose?: string | null;
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
  const user = await getUser();

  const { data: query } = (await supabase
    .from('identification_queries')
    .select('id, status, input_method, query_payload, created_at, completed_at')
    .eq('id', query_id)
    .maybeSingle()) as { data: IdentificationQuery | null };

  if (!query) notFound();

  const { data: candidates } = (await supabase
    .from('identification_candidates')
    .select(
      'id, rank, platform, handle, confidence_label, combined_score, federation_player_id, evidence, user_confirmed',
    )
    .eq('query_id', query_id)
    .order('rank', { ascending: true })) as { data: Candidate[] | null };

  // Stage 3 (sample-game) candidates land with all-null ratings + null
  // country; country-seeded chess.com handles likewise have no ratings.
  // Backfill on first render — bounded fetch against chess.com /pub and
  // lichess /api/user, persisted to platform_players + this candidate row.
  if (candidates && candidates.length > 0) {
    await enrichCandidateProfiles(candidates);
  }

  const nextPath = `/scout/match/${query_id}`;
  const signedIn = !!user;

  // When the query has a FIDE anchor, show their name. Otherwise (pure
  // sample-game paste with no anchor — common for amateurs), show a
  // descriptive label about the input instead of "(unknown subject)".
  const subjectName =
    query.query_payload.name ??
    (query.query_payload.games_pasted
      ? `AI match · ${query.query_payload.games_pasted} pasted games`
      : '(unknown subject)');
  const canOfferSampleGameFallback =
    query.status === 'ready' &&
    query.input_method !== 'sample_game' &&
    Boolean(query.query_payload.federation_player_id || query.query_payload.ad_hoc_player_id);
  const sampleGameFallbackIndex =
    canOfferSampleGameFallback && candidates && candidates.length > 0
      ? getSampleGameFallbackInsertionIndex(candidates)
      : null;

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
            {query.query_payload.ai_verdict && (
              <AiVerdictBanner
                verdict={query.query_payload.ai_verdict}
                sampleGameAvailable={sampleGameFallbackIndex !== null}
              />
            )}
            <DiscriminationNote
              candidates={candidates}
              sampleGameAvailable={sampleGameFallbackIndex !== null}
            />
            <p className="text-xs text-muted-foreground">
              Showing top {candidates.length}. Confidence is computed from handle similarity,
              country, rating-band, and title alignment.
            </p>
            {candidates.map((c, index) => (
              <Fragment key={`${c.platform}-${c.handle}`}>
                {sampleGameFallbackIndex === index && (
                  <SampleGameFallback
                    subjectName={subjectName}
                    federationPlayerId={query.query_payload.federation_player_id}
                    adHocPlayerId={query.query_payload.ad_hoc_player_id}
                    subjectLabel={query.query_payload.name}
                  />
                )}
                <CandidateCard c={c} signedIn={signedIn} nextPath={nextPath} />
              </Fragment>
            ))}
            {sampleGameFallbackIndex === candidates.length && (
              <SampleGameFallback
                subjectName={subjectName}
                federationPlayerId={query.query_payload.federation_player_id}
                adHocPlayerId={query.query_payload.ad_hoc_player_id}
                subjectLabel={query.query_payload.name}
              />
            )}
          </section>
        )}

        {canOfferSampleGameFallback && (!candidates || candidates.length === 0) && (
          <div className="mt-10">
            <SampleGameFallback
              subjectName={subjectName}
              federationPlayerId={query.query_payload.federation_player_id}
              adHocPlayerId={query.query_payload.ad_hoc_player_id}
              subjectLabel={query.query_payload.name}
            />
          </div>
        )}
      </main>
    </div>
  );
}

function getSampleGameFallbackInsertionIndex(candidates: Candidate[]): number {
  const firstWeakerCandidate = candidates.findIndex((c) => c.confidence_label !== 'high');
  if (firstWeakerCandidate > 0) return firstWeakerCandidate;
  if (firstWeakerCandidate === -1) return candidates.length;

  const topScore = candidates[0]?.combined_score ?? 0;
  const firstOutsideTopCluster = candidates.findIndex((c) => topScore - c.combined_score > 0.05);
  if (firstOutsideTopCluster > 0) return firstOutsideTopCluster;
  return Math.min(candidates.length, 3);
}

/**
 * If the top 5 candidates' confidences are all within 0.05 of each other,
 * name + country can't pick a winner. Tell the user the limit was reached
 * and point them to sample-game matching (Phase 1 W5).
 *
 * Also surfaces when nothing reaches the "medium" confidence floor — the
 * search is grasping; honest about it.
 */
/**
 * AI verdict banner — renders the LLM rerank's overall judgment above the
 * candidate cards. Only shown when /api/identify wrote one to
 * query_payload.ai_verdict (i.e., the LLM had a usable response).
 *
 * The verdict is the LLM's synthesis of name + country + rating + opening
 * fingerprint + cp-loss; it can override the algorithmic top-1 when the
 * close-call breakers (e.g., GM with cp-loss 100 = unlikely) point the
 * other way.
 */
function AiVerdictBanner({
  verdict,
  sampleGameAvailable,
}: {
  verdict: AiVerdict;
  sampleGameAvailable: boolean;
}) {
  const color =
    verdict.confidence === 'high'
      ? 'border-emerald-500/40 bg-emerald-500/5 text-emerald-500'
      : verdict.confidence === 'medium'
        ? 'border-amber-500/40 bg-amber-500/5 text-amber-500'
        : 'border-rose-500/40 bg-rose-500/5 text-rose-500';
  const showFallbackCta = sampleGameAvailable && verdict.confidence !== 'high';
  return (
    <div className={`rounded-lg border ${color.split(' ').slice(0, 2).join(' ')} p-4`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-accent">
          AI verdict
        </p>
        <p
          className={`text-xs font-semibold uppercase tracking-wider ${color.split(' ').slice(2).join(' ')}`}
        >
          {verdict.confidence} confidence
        </p>
      </div>
      <p className="mt-2 font-display text-base font-semibold tracking-tight text-foreground">
        Best match: <span className="font-mono text-accent">{verdict.best_match}</span>
      </p>
      <p className="mt-2 text-sm leading-relaxed text-foreground/90">{verdict.reasoning}</p>
      {showFallbackCta && (
        <a
          href="#sample-game-fallback"
          className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline"
        >
          Not confident? Paste a few of their games to match by play pattern ↓
        </a>
      )}
    </div>
  );
}

function DiscriminationNote({
  candidates,
  sampleGameAvailable,
}: {
  candidates: Candidate[];
  sampleGameAvailable: boolean;
}) {
  if (candidates.length === 0) return null;
  const top = candidates.slice(0, 5).map((c) => c.combined_score);
  const max = top[0] ?? 0;
  const min = top[top.length - 1] ?? max;
  const tied = top.length >= 3 && max - min <= 0.05;
  const allLow = max < 0.6;
  if (!tied && !allLow) return null;
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-amber-500">
        Low discrimination
      </p>
      <p className="mt-1 text-sm">
        {tied
          ? `Name + country matched ${candidates.length} handles with nearly identical confidence — we can't pick a winner from this signal alone.`
          : `No candidate reached a confident match. The strongest signal we have is fuzzy name match plus country.`}{' '}
        {sampleGameAvailable ? (
          <>
            Paste a few of the target&apos;s games and AI finds them by play style —{' '}
            <a href="#sample-game-fallback" className="font-semibold text-accent hover:underline">
              jump to PGN importer ↓
            </a>
          </>
        ) : (
          <>Paste a few of the target&apos;s games and AI finds them by play style.</>
        )}
      </p>
    </div>
  );
}

function SampleGameFallback({
  subjectName,
  federationPlayerId,
  adHocPlayerId,
  subjectLabel,
}: {
  subjectName: string;
  federationPlayerId?: string | null;
  adHocPlayerId?: string | null;
  subjectLabel?: string;
}) {
  return (
    <section
      id="sample-game-fallback"
      className="scroll-mt-24 rounded-lg border border-accent/40 bg-accent/5 p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-lg font-semibold">None look right?</h2>
        <span className="text-[10px] uppercase tracking-[0.2em] text-accent">AI matching</span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Paste 10+ PGN games of {subjectName} and find their accounts by play pattern instead. Works
        on amateur and titled players alike — the AI doesn&apos;t need their handle to match their
        name.
      </p>
      <div className="mt-4 max-w-2xl">
        <SampleGameForm
          federationPlayerId={federationPlayerId ?? undefined}
          adHocPlayerId={adHocPlayerId ?? undefined}
          subjectLabel={subjectLabel}
        />
      </div>
    </section>
  );
}

function CandidateCard({
  c,
  signedIn,
  nextPath,
}: {
  c: Candidate;
  signedIn: boolean;
  nextPath: string;
}) {
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

      {c.evidence.prose ? (
        <p className="mt-3 text-sm leading-relaxed text-foreground/90">{c.evidence.prose}</p>
      ) : null}

      <ul className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {c.evidence.reasons.map((r) => (
          <li key={r}>· {r}</li>
        ))}
      </ul>

      <div className="mt-4 flex items-center justify-between border-t border-border/60 pt-3">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Is this {c.handle} the right account?
        </span>
        <ConfirmButtons
          candidateId={c.id}
          initial={c.user_confirmed}
          signedIn={signedIn}
          nextPath={nextPath}
        />
      </div>
    </div>
  );
}
