'use client';

/**
 * Phase 4 UI: renders the two-handle bucketed-repertoire diff returned by
 * GET /api/prepare/correlate. Mounts on /prepare/[platform]/[handle] when
 * `?me=...&mePlatform=...` URL params are present so we know "your"
 * handle. This is the v1 surface for the Prep Plan product — the picker
 * UX + paywall arrive once user→handle linking lands.
 */
import { useEffect, useState } from 'react';
import type { Platform } from '@/lib/prepare/types';

interface TopMoveSummary {
  san: string;
  uci: string;
  gamesCount: number;
  wins: number;
  draws: number;
  losses: number;
  scoreShare: number;
}

interface AggregateScore {
  totalGames: number;
  wins: number;
  draws: number;
  losses: number;
  scoreShare: number;
}

interface OverlapPosition {
  yourFenKey: string;
  yourMove: TopMoveSummary;
  theirFenKey: string;
  theirResponses: TopMoveSummary[];
  theirAggregate: AggregateScore;
  opportunityScore: number;
}

interface DriftPosition {
  fenKey: string;
  allTime: {
    totalGames: number;
    scoreShare: number;
    topMove: { san: string; share: number } | null;
  };
  recent: {
    totalGames: number;
    scoreShare: number;
    topMove: { san: string; share: number } | null;
  };
  scoreDelta: number;
  topMoveChanged: boolean;
  mixDistance: number;
}

interface BucketInfo {
  timeBucket: string;
  bucketSince: string | null;
  bucketUntil: string | null;
}

interface CorrelateResponse {
  me: { platform: string; handle: string };
  opp: { platform: string; handle: string };
  depth: number;
  overlapBucket: BucketInfo | null;
  driftBuckets: { baseline: BucketInfo | null; recent: BucketInfo | null };
  asWhite: OverlapPosition[];
  asBlack: OverlapPosition[];
  driftAsWhite: DriftPosition[];
  driftAsBlack: DriftPosition[];
  meBuckets: string[];
  oppBuckets: string[];
}

interface CorrelateError {
  error: string;
  missing?: { me: boolean; opp: boolean };
  hint?: string;
}

interface ExplainLine {
  title: string;
  yourMove: string;
  why: string;
}

interface ExplainResponseAvailable {
  available: true;
  headline: string;
  lines: ExplainLine[];
  driftCallouts: string[];
  provider: string;
}

interface ExplainResponseUnavailable {
  available: false;
  reason?: string;
}

type ExplainResponse = ExplainResponseAvailable | ExplainResponseUnavailable;

interface Props {
  oppPlatform: Platform;
  oppHandle: string;
  mePlatform: Platform;
  meHandle: string;
}

type State =
  | { phase: 'loading' }
  | { phase: 'error'; message: string; missing?: { me: boolean; opp: boolean } }
  | { phase: 'ready'; data: CorrelateResponse };

export function CorrelationSection({ oppPlatform, oppHandle, mePlatform, meHandle }: Props) {
  const [state, setState] = useState<State>({ phase: 'loading' });
  // Phase 5: the explainer runs after correlate succeeds. Kept as separate
  // state so a slow LLM call doesn't block the raw correlation panel.
  const [explain, setExplain] = useState<
    { phase: 'loading' } | { phase: 'ready'; data: ExplainResponse } | null
  >(null);

  useEffect(() => {
    const ac = new AbortController();
    setState({ phase: 'loading' });
    setExplain(null);
    (async () => {
      const url = new URL('/api/prepare/correlate', window.location.origin);
      url.searchParams.set('me_platform', mePlatform);
      url.searchParams.set('me_handle', meHandle);
      url.searchParams.set('opp_platform', oppPlatform);
      url.searchParams.set('opp_handle', oppHandle);
      try {
        const res = await fetch(url.toString(), { signal: ac.signal });
        if (res.status === 404) {
          const body = (await res.json()) as CorrelateError;
          setState({
            phase: 'error',
            message: body.hint ?? 'One or both handles do not have bucketed repertoires yet.',
            missing: body.missing,
          });
          return;
        }
        if (!res.ok) {
          setState({ phase: 'error', message: `HTTP ${res.status}` });
          return;
        }
        const data = (await res.json()) as CorrelateResponse;
        setState({ phase: 'ready', data });

        // Kick off the explainer in parallel — fire-and-forget, doesn't
        // gate the raw correlation panel. Errors surface as `available: false`
        // so the UI just skips the prose section.
        setExplain({ phase: 'loading' });
        const explainRes = await fetch('/api/prepare/explain', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
          signal: ac.signal,
        });
        if (ac.signal.aborted) return;
        const explainData = (await explainRes.json()) as ExplainResponse;
        setExplain({ phase: 'ready', data: explainData });
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'Failed to load correlation',
        });
      }
    })();
    return () => ac.abort();
  }, [oppPlatform, oppHandle, mePlatform, meHandle]);

  return (
    <section className="rounded-xl border border-border bg-card p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-xl font-semibold">Prep plan vs {oppHandle}</h2>
        <p className="text-[11px] uppercase tracking-[0.15em] text-accent">
          you ({meHandle}) vs them
        </p>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        Two-handle bucketed-repertoire diff — surfaces lines you reach where they struggle, plus
        positions where their recent play differs from their lifetime baseline.
      </p>

      <div className="mt-5">{renderState(state, explain)}</div>
    </section>
  );
}

function renderState(
  state: State,
  explain: { phase: 'loading' } | { phase: 'ready'; data: ExplainResponse } | null,
) {
  if (state.phase === 'loading') {
    return <p className="text-sm text-muted-foreground">Loading correlation engine output…</p>;
  }
  if (state.phase === 'error') {
    return (
      <div className="rounded-md border border-dashed border-border bg-card px-4 py-6 text-sm text-muted-foreground">
        <p>{state.message}</p>
        {state.missing ? (
          <ul className="mt-2 list-disc pl-5 text-xs">
            {state.missing.me ? <li>Your repertoire is not yet built.</li> : null}
            {state.missing.opp ? <li>Opponent&apos;s repertoire is not yet built.</li> : null}
            <li>
              Hit the page again in a few hours — the worker pipeline catches up after enqueue.
            </li>
          </ul>
        ) : null}
      </div>
    );
  }
  const { data } = state;
  return (
    <div className="space-y-6">
      <BucketBanner data={data} />
      <ExplainPanel explain={explain} />
      <OverlapList title="You as White → them as Black" entries={data.asWhite} />
      <OverlapList title="You as Black → them as White" entries={data.asBlack} />
      <DriftList
        title="Their recent play vs lifetime — as Black (what you face as White)"
        entries={data.driftAsWhite}
      />
      <DriftList
        title="Their recent play vs lifetime — as White (what you face as Black)"
        entries={data.driftAsBlack}
      />
    </div>
  );
}

function ExplainPanel({
  explain,
}: {
  explain: { phase: 'loading' } | { phase: 'ready'; data: ExplainResponse } | null;
}) {
  if (!explain) return null;
  if (explain.phase === 'loading') {
    return (
      <div className="rounded-md border border-dashed border-accent/40 bg-accent/5 px-4 py-3 text-sm text-muted-foreground">
        Generating prep brief…
      </div>
    );
  }
  const data = explain.data;
  if (!data.available) return null;
  return (
    <div className="rounded-md border border-accent/40 bg-accent/5 px-4 py-3">
      <p className="text-[11px] uppercase tracking-[0.15em] text-accent">AI prep brief</p>
      <p className="mt-2 text-sm">{data.headline}</p>
      {data.lines.length > 0 ? (
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm">
          {data.lines.map((l, i) => (
            <li key={i}>
              <span className="font-semibold">{l.title}</span> —{' '}
              <span className="text-accent">{l.yourMove}</span>
              <div className="text-xs text-muted-foreground">{l.why}</div>
            </li>
          ))}
        </ol>
      ) : null}
      {data.driftCallouts.length > 0 ? (
        <div className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground">
          <p className="font-semibold">Style drift to watch:</p>
          <ul className="mt-1 list-disc pl-5">
            {data.driftCallouts.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function BucketBanner({ data }: { data: CorrelateResponse }) {
  const overlap = data.overlapBucket;
  const drift = data.driftBuckets;
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2 text-[11px] uppercase tracking-[0.15em] text-muted-foreground">
      Depth {data.depth}
      {overlap ? ` · overlap window: ${overlap.timeBucket}` : ''}
      {drift.recent && drift.baseline
        ? ` · drift: ${drift.recent.timeBucket} vs ${drift.baseline.timeBucket}`
        : ''}
    </div>
  );
}

function OverlapList({ title, entries }: { title: string; entries: OverlapPosition[] }) {
  return (
    <div>
      <h3 className="text-sm font-semibold">{title}</h3>
      {entries.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          No overlap found at the current minimum-games threshold. (Try refreshing after corpus
          grows.)
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {entries.slice(0, 8).map((e, i) => (
            <li
              key={`${e.yourFenKey}:${e.yourMove.uci}:${i}`}
              className="rounded border border-border bg-background px-3 py-2 text-xs"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold">
                  Your <span className="text-accent">{e.yourMove.san}</span> (
                  {e.yourMove.gamesCount} games) → they reach{' '}
                  <span className="text-foreground">{e.theirAggregate.totalGames}</span> times
                </span>
                <span className="text-muted-foreground">
                  their score: {(e.theirAggregate.scoreShare * 100).toFixed(0)}% · opp:{' '}
                  {e.opportunityScore.toFixed(1)}
                </span>
              </div>
              <div className="mt-1 text-muted-foreground">
                their top responses:{' '}
                {e.theirResponses
                  .map((r) => `${r.san} (${r.gamesCount}g, ${(r.scoreShare * 100).toFixed(0)}%)`)
                  .join(' · ')}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DriftList({ title, entries }: { title: string; entries: DriftPosition[] }) {
  return (
    <div>
      <h3 className="text-sm font-semibold">{title}</h3>
      {entries.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">No material drift detected.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {entries.slice(0, 6).map((d, i) => (
            <li
              key={`${d.fenKey}:${i}`}
              className="rounded border border-border bg-background px-3 py-2 text-xs"
            >
              <div className="font-mono text-[10px] text-muted-foreground">
                {d.fenKey.slice(0, 60)}…
              </div>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                {d.topMoveChanged ? (
                  <span>
                    top move:{' '}
                    <span className="text-muted-foreground line-through">
                      {d.allTime.topMove?.san}
                    </span>{' '}
                    → <span className="text-accent">{d.recent.topMove?.san}</span>
                  </span>
                ) : (
                  <span>
                    top move stable: <span className="font-semibold">{d.recent.topMove?.san}</span>
                  </span>
                )}
                <span>
                  score: {(d.allTime.scoreShare * 100).toFixed(0)}% →{' '}
                  <span
                    className={
                      d.scoreDelta > 0 ? 'text-emerald-500' : d.scoreDelta < 0 ? 'text-red-500' : ''
                    }
                  >
                    {(d.recent.scoreShare * 100).toFixed(0)}%
                  </span>{' '}
                  ({d.scoreDelta >= 0 ? '+' : ''}
                  {(d.scoreDelta * 100).toFixed(0)}pp)
                </span>
                <span className="text-muted-foreground">
                  mix-shift: {d.mixDistance.toFixed(2)} ({d.allTime.totalGames}g →{' '}
                  {d.recent.totalGames}g)
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
