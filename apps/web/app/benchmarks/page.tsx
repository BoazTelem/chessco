import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getIndexStats } from '@/lib/index-stats';
import { LiveChessWaitlistForm } from '@/components/benchmarks/LiveChessWaitlistForm';

export const metadata: Metadata = {
  title: 'How chessco works',
  description:
    'Scout an opponent, build their opening tree, find their leaks, prepare with bots / positions / coaches, and play Live Chess with mutual webcams. Coverage and accuracy benchmarks updated daily.',
};

// ============================================================================
// Loaders — JSON artifacts written by apps/workers eval scripts. Daily refresh
// is wired through .github/workflows/daily-benchmarks.yml.
// ============================================================================

type VerdictStatus = 'pass' | 'fail' | 'pending' | 'error';

type Verdict = {
  id: string;
  title: string;
  status: VerdictStatus;
  headline: string;
  criteria: Array<{ label: string; threshold: string; actual: string; passed: boolean }>;
  source?: { artifact: string; runAt: string | null };
  generatedAt: string;
  error?: string;
};

function loadJson<T>(filenames: string[]): T | null {
  for (const filename of filenames) {
    const candidates = [
      join(process.cwd(), 'public', filename),
      join(process.cwd(), 'apps', 'web', 'public', filename),
    ];
    const path = candidates.find((p) => existsSync(p));
    if (!path) continue;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch {
      return null;
    }
  }
  return null;
}

function loadVerdict(id: string): Verdict | null {
  return loadJson<Verdict>([`benchmarks/${id}.json`]);
}

type CoverageTier = {
  label: string;
  fide_pool: number;
  claimed_total: number;
  claimed_lichess: number;
  claimed_chesscom: number;
  coverage_pct: number;
  v1_target_pct: number;
  realistic_max_pct: number;
};

type CoverageStats = {
  as_of: string;
  methodology: string;
  totals: {
    fide_pool_1400_plus: number;
    titled_pool: number;
    platforms: Record<string, { matchable: number; claimed: number }>;
  };
  tiers: CoverageTier[];
};

type SparseMetrics = {
  trials: number;
  top1: number;
  top3: number;
  top10: number;
  median_rank: number | null;
  mrr: number;
};

type SparseBenchmark = {
  version: 'v1';
  ts: string;
  finished_at: string;
  duration_seconds: number;
  config: {
    platform: 'both' | 'chess.com' | 'lichess';
    limit: number;
    sample_sizes: number[];
    seeds: number[];
    top_k: number;
  };
  corpus_size: Record<string, number>;
  total_targets: number;
  total_trials: number;
  metrics_by_sample_size: Array<{ sample_size: number; metrics: SparseMetrics }>;
  metrics_by_platform?: Record<string, Array<{ sample_size: number; metrics: SparseMetrics }>>;
  guidance: {
    quick_scan: number | null;
    recommended: number | null;
    high_confidence: number | null;
    rules: { quick_scan: string; recommended: string; high_confidence: string };
  };
};

type LegacyMetrics = {
  n: number;
  top1: number;
  top3: number;
  top5: number;
  top10: number;
  mrr: number;
  median_rank: number | null;
  mean_rank: number | null;
  mean_top_score: number | null;
  mean_target_score: number | null;
  false_positive_rate_top1: number;
};

type LegacyBenchmark = {
  run_at: string;
  methodology: string;
  config: {
    account_limit: number;
    platform: string | null;
    sample_sizes: number[];
    seeds: number[];
    depth: number;
    min_train_games: number;
  };
  corpus: {
    selected_accounts: number;
    eligible_accounts: number;
    raw_game_rows_loaded: number;
    moves_loaded: number;
    vector_keys: number;
    metadata_accounts: number;
  };
  guidance: {
    quick_scan_games: number | null;
    recommended_games: number | null;
    high_confidence_games: number | null;
    thresholds: Record<string, string>;
  };
  metrics_by_sample_size: Array<{ sample_size: number; metrics: LegacyMetrics }>;
};

// ============================================================================
// Helpers
// ============================================================================

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}
function int(v: number | null): string {
  return v === null ? 'not met' : `${v}`;
}
function num(v: number): string {
  return v.toLocaleString();
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
      {detail ? <p className="mt-1 text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

function StagePill({ n, title, href }: { n: number; title: string; href: string }) {
  return (
    <Link
      href={href}
      className="group flex flex-1 items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm hover:border-accent hover:text-accent"
    >
      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-background text-xs text-muted-foreground group-hover:border-accent group-hover:text-accent">
        {n}
      </span>
      <span className="truncate">{title}</span>
    </Link>
  );
}

function UpdatedBadge({ iso, label = 'Updated daily' }: { iso: string | null; label?: string }) {
  if (!iso) return null;
  const d = new Date(iso);
  const text = Number.isFinite(d.getTime()) ? d.toLocaleDateString() : iso;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-300">
      <span aria-hidden>●</span>
      {label} · last refresh {text}
    </span>
  );
}

function latestRefresh(
  coverage: CoverageStats | null,
  sparse: SparseBenchmark | null,
): string | null {
  const dates = [coverage?.as_of, sparse?.finished_at, sparse?.ts].filter(
    (s): s is string => typeof s === 'string',
  );
  let best: string | null = null;
  let bestT = -Infinity;
  for (const d of dates) {
    const t = new Date(d).getTime();
    if (Number.isFinite(t) && t > bestT) {
      best = d;
      bestT = t;
    }
  }
  return best;
}

function CoverageBar({ current, target, max }: { current: number; target: number; max: number }) {
  const denom = Math.max(max, target, current, 1);
  const fillPct = Math.min(100, (current / denom) * 100);
  const targetPct = Math.min(100, (target / denom) * 100);
  const reached = current >= target;
  return (
    <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={`h-full ${reached ? 'bg-emerald-500/70' : 'bg-amber-500/70'}`}
        style={{ width: `${fillPct}%` }}
      />
      <div
        className="absolute top-0 h-full w-px bg-foreground/60"
        style={{ left: `${targetPct}%` }}
        title={`v1 target ${target}%`}
        aria-label={`v1 target ${target}%`}
      />
    </div>
  );
}

// ============================================================================
// Hero — product story in 30 seconds + summary proof tiles
// ============================================================================

function HeroSection({
  coverage,
  sparse,
  refresh,
}: {
  coverage: CoverageStats | null;
  sparse: SparseBenchmark | null;
  refresh: string | null;
}) {
  const titledTier = coverage?.tiers.find((t) => t.label.toLowerCase().startsWith('titled'));
  const tenGameRow =
    sparse?.metrics_by_sample_size.find((r) => r.sample_size === 10) ??
    sparse?.metrics_by_sample_size.at(-1) ??
    null;

  return (
    <section className="mt-10">
      <header className="max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">How it works</p>
        <h1 className="mt-2 font-display text-4xl font-semibold md:text-5xl">
          From a name to a prepared game — in five steps.
        </h1>
        <p className="mt-4 text-base leading-7 text-muted-foreground md:text-lg">
          Search any tournament player → find their online account on chess.com or Lichess → build
          their opening tree from real games → compare it to yours and surface their leaks → prepare
          by playing their imitating bot, drilling positions, or booking a coach. New:{' '}
          <strong className="text-foreground">Live Chess</strong> — play strangers with webcams on
          both sides, the closest thing to over-the-board online.
        </p>
      </header>

      <div className="mt-6 flex flex-wrap gap-2">
        <StagePill n={1} title="Scout the opponent" href="#stage-scout" />
        <StagePill n={2} title="Build their tree" href="#stage-tree" />
        <StagePill n={3} title="Find the leaks" href="#stage-leaks" />
        <StagePill n={4} title="Prepare" href="#stage-practice" />
        <StagePill n={5} title="Live Chess" href="#stage-live-chess" />
      </div>

      <div className="mt-8 grid gap-3 md:grid-cols-3">
        <div className="rounded-md border border-accent/40 bg-accent/5 p-4">
          <p className="text-xs uppercase tracking-wide text-accent">Name search coverage</p>
          {titledTier ? (
            <>
              <p className="mt-2 text-3xl font-semibold">{titledTier.coverage_pct.toFixed(1)}%</p>
              <p className="mt-1 text-xs text-muted-foreground">
                of titled FIDE players mapped to an online account · we track every rating band, not
                just titles — see the full tier table below.
              </p>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">Coverage benchmark pending.</p>
          )}
        </div>

        <div className="rounded-md border border-border bg-card p-4">
          <p className="text-xs uppercase tracking-wide text-foreground">PGN benchmark accuracy</p>
          {tenGameRow ? (
            <>
              <p className="mt-2 text-3xl font-semibold">{pct(tenGameRow.metrics.top1)}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                top-1 account identified from {tenGameRow.sample_size} sampled games ·{' '}
                {pct(tenGameRow.metrics.top10)} top-10.
              </p>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">Cascade benchmark pending.</p>
          )}
        </div>

        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-4">
          <p className="text-xs uppercase tracking-wide text-emerald-300">Daily refresh</p>
          {refresh ? (
            <>
              <p className="mt-2 text-2xl font-semibold">
                {new Date(refresh).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Coverage and PGN accuracy re-run nightly (
                <code className="rounded bg-muted px-1 py-0.5 text-[10px]">eval:coverage</code>
                {' + '}
                <code className="rounded bg-muted px-1 py-0.5 text-[10px]">eval:cascade</code>) and
                committed to this page.
              </p>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              Nightly refresh wires through .github/workflows/daily-benchmarks.yml.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

// ============================================================================
// Stage 1 — Scout (name search + PGN fallback + coverage + accuracy tables)
// ============================================================================

function ScoutStage({
  coverage,
  sparse,
  indexStats,
}: {
  coverage: CoverageStats | null;
  sparse: SparseBenchmark | null;
  indexStats: Awaited<ReturnType<typeof getIndexStats>>;
}) {
  const platformHandles = indexStats.chesscomHandles + indexStats.lichessHandles;
  const totalGames = indexStats.chesscomGames + indexStats.lichessGames;

  return (
    <section id="stage-scout" className="mt-16 scroll-mt-16 border-t border-border pt-10">
      <header className="max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Stage 1</p>
        <h2 className="mt-1 font-display text-2xl font-semibold md:text-3xl">
          Scout — find your opponent.
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Start by name. Filter by federation (FIDE / ICF / USCF), title (GM / IM / FM / …),
          country, and rating range. Scout returns federation matches, claimed online handles, and
          community-verified ad-hoc players in one list.
        </p>
      </header>

      <div className="mt-4 flex flex-wrap gap-3">
        <Link
          href="/scout"
          className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground hover:opacity-90"
        >
          Open Scout →
        </Link>
        <a
          href="#stage-scout-coverage"
          className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm hover:border-accent hover:text-accent"
        >
          See coverage by tier ↓
        </a>
      </div>

      <div className="mt-8 grid gap-3 md:grid-cols-4">
        <Stat
          label="Federation players indexed"
          value={num(indexStats.federationTotal)}
          detail={`FIDE ${num(indexStats.fide)} · ICF ${num(indexStats.icf)}${
            indexStats.uscf > 0 ? ` · USCF ${num(indexStats.uscf)}` : ' · USCF via FIDE-USA slice'
          }`}
        />
        <Stat
          label="Online handles seeded"
          value={num(indexStats.platformTotal)}
          detail="chess.com + Lichess handles linked to federation IDs"
        />
        <Stat
          label="Live game-corpus handles"
          value={num(platformHandles)}
          detail={`chess.com ${num(indexStats.chesscomHandles)} · Lichess ${num(indexStats.lichessHandles)}`}
        />
        <Stat
          label="Games ingested"
          value={num(totalGames)}
          detail="from rated online play + Lichess broadcast tournaments"
        />
      </div>

      <div className="mt-10 grid gap-4 md:grid-cols-2">
        <div className="rounded-md border border-border bg-card p-5">
          <h3 className="font-display text-lg font-semibold">Not registered? Two fallbacks.</h3>
          <ul className="mt-3 space-y-2 text-sm leading-6 text-muted-foreground">
            <li>
              <strong className="text-foreground">Add them by name.</strong> Type a player Scout
              doesn&apos;t know yet and you create an ad-hoc target. Community-verified ad-hoc
              players show up alongside federation + platform matches for the next searcher.
            </li>
            <li>
              <strong className="text-foreground">Paste their PGN.</strong> A few of their games is
              enough — the sparse cascade matches by opening repertoire and tempo signature,
              regardless of how anonymous their handle is. Accuracy table below tells you how many
              games to paste.
            </li>
          </ul>
        </div>
        <div className="rounded-md border border-border bg-card p-5">
          <h3 className="font-display text-lg font-semibold">Tournament games come to you.</h3>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            We auto-ingest Lichess broadcast tournaments every 30 minutes. If your opponent played a
            broadcast event — a Grand Prix, a national championship, a weekend open with live relay
            — their games are already in the corpus the moment you search them. No PGN upload needed
            for those games.
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            Ingest worker:{' '}
            <code className="rounded bg-muted px-1 py-0.5">
              apps/workers/src/inngest/external-pgn-broadcasts.ts
            </code>
          </p>
        </div>
      </div>

      {coverage ? <CoverageBlock stats={coverage} /> : null}
      {sparse ? <CascadeBlock benchmark={sparse} /> : null}
    </section>
  );
}

function CoverageBlock({ stats }: { stats: CoverageStats }) {
  return (
    <div
      id="stage-scout-coverage"
      className="mt-10 scroll-mt-16 overflow-hidden rounded-md border border-border"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-4 py-3">
        <div>
          <h3 className="font-display text-lg font-semibold">Name-search coverage by FIDE tier</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Club players matter as much as GMs — we benchmark coverage at every rating band, not
            just titled players.
          </p>
        </div>
        <UpdatedBadge iso={stats.as_of} />
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-muted/40 text-left text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Tier</th>
              <th className="px-4 py-3 font-medium">FIDE pool</th>
              <th className="px-4 py-3 font-medium">Claimed</th>
              <th className="px-4 py-3 font-medium">Coverage</th>
              <th className="px-4 py-3 font-medium">v1 target</th>
              <th className="px-4 py-3 font-medium">Max</th>
              <th className="w-1/4 px-4 py-3 font-medium">Progress</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {stats.tiers.map((tier) => (
              <tr key={tier.label} className="bg-background">
                <td className="px-4 py-3 font-medium">{tier.label}</td>
                <td className="px-4 py-3">{num(tier.fide_pool)}</td>
                <td className="px-4 py-3">
                  {num(tier.claimed_total)}
                  <span className="ml-1 text-xs text-muted-foreground">
                    (li {num(tier.claimed_lichess)} · cc {num(tier.claimed_chesscom)})
                  </span>
                </td>
                <td className="px-4 py-3 font-medium">{tier.coverage_pct.toFixed(2)}%</td>
                <td className="px-4 py-3 text-muted-foreground">{tier.v1_target_pct}%</td>
                <td className="px-4 py-3 text-muted-foreground">{tier.realistic_max_pct}%</td>
                <td className="px-4 py-3">
                  <CoverageBar
                    current={tier.coverage_pct}
                    target={tier.v1_target_pct}
                    max={tier.realistic_max_pct}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-border bg-card px-4 py-3 text-xs text-muted-foreground">
        {stats.methodology}
      </p>
    </div>
  );
}

function CascadeBlock({ benchmark }: { benchmark: SparseBenchmark }) {
  const corpusTotal = Object.values(benchmark.corpus_size).reduce((a, b) => a + b, 0);
  const latest = benchmark.metrics_by_sample_size.at(-1);

  return (
    <div className="mt-8 overflow-hidden rounded-md border border-border">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-4 py-3">
        <div>
          <h3 className="font-display text-lg font-semibold">PGN-search accuracy by sample size</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            For {num(benchmark.total_targets)} random fingerprinted handles we sample N games and
            ask the cascade to identify the target. {num(corpusTotal)} handles fingerprinted across
            chess.com + Lichess.
          </p>
        </div>
        <UpdatedBadge iso={benchmark.finished_at ?? benchmark.ts} />
      </div>

      <div className="grid gap-3 border-b border-border bg-card/50 p-4 md:grid-cols-3">
        <Stat
          label="Quick scan"
          value={`${int(benchmark.guidance.quick_scan)} games`}
          detail={benchmark.guidance.rules.quick_scan}
        />
        <Stat
          label="Recommended"
          value={`${int(benchmark.guidance.recommended)} games`}
          detail={benchmark.guidance.rules.recommended}
        />
        <Stat
          label="High-confidence"
          value={`${int(benchmark.guidance.high_confidence)} games`}
          detail={benchmark.guidance.rules.high_confidence}
        />
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-muted/40 text-left text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Games</th>
              <th className="px-4 py-3 font-medium">Trials</th>
              <th className="px-4 py-3 font-medium">Top 1</th>
              <th className="px-4 py-3 font-medium">Top 3</th>
              <th className="px-4 py-3 font-medium">Top 10</th>
              <th className="px-4 py-3 font-medium">Median rank</th>
              <th className="px-4 py-3 font-medium">MRR</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {benchmark.metrics_by_sample_size.map(({ sample_size, metrics }) => (
              <tr key={sample_size} className="bg-background">
                <td className="px-4 py-3 font-medium">{sample_size}</td>
                <td className="px-4 py-3">{num(metrics.trials)}</td>
                <td className="px-4 py-3">{pct(metrics.top1)}</td>
                <td className="px-4 py-3">{pct(metrics.top3)}</td>
                <td className="px-4 py-3">{pct(metrics.top10)}</td>
                <td className="px-4 py-3">{metrics.median_rank ?? 'n/a'}</td>
                <td className="px-4 py-3">{metrics.mrr.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {benchmark.metrics_by_platform ? (
        <div className="grid gap-0 border-t border-border md:grid-cols-2">
          {Object.entries(benchmark.metrics_by_platform).map(([plat, rows]) => (
            <div
              key={plat}
              className="border-b border-border md:border-b-0 md:[&:not(:last-child)]:border-r"
            >
              <div className="bg-card px-4 py-2">
                <h4 className="text-sm font-medium">{plat}</h4>
              </div>
              <table className="min-w-full text-xs">
                <thead className="bg-muted/40 text-left text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Games</th>
                    <th className="px-3 py-2 font-medium">Trials</th>
                    <th className="px-3 py-2 font-medium">Top 1</th>
                    <th className="px-3 py-2 font-medium">Top 3</th>
                    <th className="px-3 py-2 font-medium">Top 10</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map(({ sample_size, metrics }) => (
                    <tr key={sample_size} className="bg-background">
                      <td className="px-3 py-2">{sample_size}</td>
                      <td className="px-3 py-2">{num(metrics.trials)}</td>
                      <td className="px-3 py-2">{pct(metrics.top1)}</td>
                      <td className="px-3 py-2">{pct(metrics.top3)}</td>
                      <td className="px-3 py-2">{pct(metrics.top10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      ) : null}

      <p className="border-t border-border bg-card px-4 py-3 text-xs text-muted-foreground">
        Methodology: Stage A SQL prefilter → Stage B term retrieval over{' '}
        <code className="rounded bg-muted px-1 py-0.5">fingerprint_terms</code> → Stage C
        combined-score re-rank. Last full run took {Math.round(benchmark.duration_seconds / 60)} min
        on {num(benchmark.total_trials)} trials.
        {latest
          ? ` Current read at ${latest.sample_size} games: ${pct(latest.metrics.top1)} top-1, ${pct(
              latest.metrics.top10,
            )} top-10.`
          : ''}
      </p>
    </div>
  );
}

// ============================================================================
// Stage 2 — Build their opening tree
// ============================================================================

function TreeStage() {
  return (
    <section id="stage-tree" className="mt-16 scroll-mt-16 border-t border-border pt-10">
      <header className="max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Stage 2</p>
        <h2 className="mt-1 font-display text-2xl font-semibold md:text-3xl">
          Build their opening tree.
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Once we know which handle is theirs, the worker walks every game we have for them and
          builds two trees — a shallow depth-12 tree the matcher uses, and a deep depth-30 tree the
          prep UI shows you. Split by color (their white repertoire and their black repertoire are
          separate), recency-weighted so what they played last month counts more than what they
          played three years ago.
        </p>
      </header>

      <div className="mt-6 grid gap-3 md:grid-cols-3">
        <Stat
          label="Matcher depth"
          value="12 plies"
          detail="fast enough to fingerprint every handle in the corpus"
        />
        <Stat
          label="Prep UI depth"
          value="30 plies"
          detail="deep enough to play out a real opening line"
        />
        <Stat
          label="Stored as"
          value="JSONB"
          detail="player_repertoires table; rebuilt on new games"
        />
      </div>

      <p className="mt-6 text-xs text-muted-foreground">
        Builder:{' '}
        <code className="rounded bg-muted px-1 py-0.5">apps/workers/src/repertoires/build.ts</code>
      </p>
    </section>
  );
}

// ============================================================================
// Stage 3 — Leaks
// ============================================================================

function LeaksStage() {
  return (
    <section id="stage-leaks" className="mt-16 scroll-mt-16 border-t border-border pt-10">
      <header className="max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Stage 3</p>
        <h2 className="mt-1 font-display text-2xl font-semibold md:text-3xl">
          Find their leaks — by comparing their tree to yours.
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          A leak isn&apos;t just a bad move they played once. It&apos;s a position you&apos;ll
          actually reach, that they fall into often, where they play moves engines hate. We walk
          your tree against theirs and rank candidates by:
        </p>
      </header>

      <div className="mt-6 overflow-hidden rounded-md border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <p className="font-mono text-sm">
            score = <span className="text-accent">your reach</span> ×{' '}
            <span className="text-accent">their reach</span> ×{' '}
            <span className="text-accent">bad-move share</span> ×{' '}
            <span className="text-accent">severity</span>
          </p>
        </div>
        <ul className="divide-y divide-border text-sm">
          <li className="px-4 py-3">
            <strong className="text-foreground">Your reach</strong> — how often your repertoire
            actually reaches the position. A leak in a line you never play is noise.
          </li>
          <li className="px-4 py-3">
            <strong className="text-foreground">Their reach</strong> — how often they let it happen.
            Once-in-fifty isn&apos;t a leak.
          </li>
          <li className="px-4 py-3">
            <strong className="text-foreground">Bad-move share</strong> — what fraction of their
            replies in that position the engine flags as mistakes or blunders (avg CP loss ≥ 100,
            high mistake / blunder rate).
          </li>
          <li className="px-4 py-3">
            <strong className="text-foreground">Severity</strong> — how badly engines rate the bad
            move. Losing a pawn is not losing the game.
          </li>
        </ul>
      </div>

      <p className="mt-4 text-sm text-muted-foreground">
        The leak report names the SAN line into the position, their bad move, the engine&apos;s
        preferred move, and which of your repertoire branches gets you there.{' '}
        <Link href="/prepare" className="text-accent hover:underline">
          See it on /prepare →
        </Link>
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        Scoring engine:{' '}
        <code className="rounded bg-muted px-1 py-0.5">apps/web/lib/leaks/score.ts</code>
      </p>
    </section>
  );
}

// ============================================================================
// Stage 4 — Practice
// ============================================================================

function PracticeStage() {
  return (
    <section id="stage-practice" className="mt-16 scroll-mt-16 border-t border-border pt-10">
      <header className="max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Stage 4</p>
        <h2 className="mt-1 font-display text-2xl font-semibold md:text-3xl">
          Prepare — bots, positions, coaches.
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Knowing the leaks is half the work. The other half is drilling them in conditions close to
          the real game.
        </p>
      </header>

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <div className="flex flex-col rounded-md border border-border bg-card p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">Imitating bot</p>
          <h3 className="mt-2 font-display text-lg font-semibold">Play vs their style.</h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Maia-powered bots that play like a human at a given strength — not a stockfish-with-the-
            knob-turned-down. Casual mode is free;{' '}
            <strong className="text-foreground">credit mode</strong> stakes ±1 credit per game and
            requires the bot rating to be at least your verified rating (so you can&apos;t farm
            credits by sparring 1000-rated bots).
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Coming soon: bots fine-tuned to play like <em>your specific opponent</em>, not just a
            generic strength bot.
          </p>
          <div className="mt-auto pt-4">
            <Link
              href="/practice/sandbox"
              className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-foreground hover:opacity-90"
            >
              Open practice →
            </Link>
          </div>
        </div>

        <div className="flex flex-col rounded-md border border-border bg-card p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">
            Play from a position
          </p>
          <h3 className="mt-2 font-display text-lg font-semibold">Drill the leak position.</h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Start the bot game from the exact position where the leak appears, so you&apos;re
            practising the move you&apos;ll actually need on the day. Position-vs-human sparring is
            on the waitlist — join from the home pillar tile.
          </p>
          <div className="mt-auto pt-4">
            <Link
              href="/practice"
              className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-semibold hover:border-accent hover:text-accent"
            >
              See practice modes →
            </Link>
          </div>
        </div>

        <div className="flex flex-col rounded-md border border-border bg-card p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">Coaches</p>
          <h3 className="mt-2 font-display text-lg font-semibold">Book a coach for the round.</h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Hand a coach your leak report and play through it before the game. Coaches see your
            student dashboard; you see their availability.
          </p>
          <div className="mt-auto pt-4">
            <Link
              href="/coach/students"
              className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-semibold hover:border-accent hover:text-accent"
            >
              Coach surfaces →
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

// ============================================================================
// Stage 5 — Live Chess (NEW — explainer + waitlist)
// ============================================================================

function LiveChessStage() {
  return (
    <section
      id="stage-live-chess"
      className="mt-16 scroll-mt-16 rounded-lg border border-accent/40 bg-gradient-to-br from-accent/10 to-transparent p-6 md:p-8"
    >
      <header className="max-w-3xl">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">
            Stage 5 · New
          </p>
          <span className="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-accent">
            Coming soon
          </span>
        </div>
        <h2 className="mt-2 font-display text-2xl font-semibold md:text-3xl">
          Live Chess — play with your face on the line.
        </h2>
        <p className="mt-3 text-sm leading-6 text-muted-foreground md:text-base">
          The pairing engine only matches you with players whose browser has granted webcam access
          and is sending a live video track.{' '}
          <strong className="text-foreground">No webcam, no match.</strong> The closest thing to
          over-the-board chess you can get online: you see your opponent, they see you, you
          can&apos;t silently disengage.
        </p>
      </header>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="rounded-md border border-border bg-card p-5">
          <h3 className="font-display text-base font-semibold">Mutual-webcam matchmaking</h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Both browsers must approve the camera permission in real time before the pair is
            proposed. If either side revokes the camera mid-game, the match ends immediately. Video
            is peer-to-peer between the two players — chessco never records or stores it.
          </p>
        </div>
        <div className="rounded-md border border-border bg-card p-5">
          <h3 className="font-display text-base font-semibold">Webcam companion for chess.com</h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Playing on chess.com? Open a chessco Live Chess window beside your game — same
            face-to-face presence, your existing rated chess.com game on the other monitor. We never
            touch their board.
          </p>
        </div>
      </div>

      <div className="mt-6 rounded-md border border-border bg-card p-5">
        <h3 className="font-display text-base font-semibold">Join the Live Chess waitlist</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          We&apos;ll email when mutual-webcam matchmaking opens. Pick a preferred time class so we
          can prioritise pairing pools you actually want.
        </p>
        <div className="mt-4">
          <LiveChessWaitlistForm />
        </div>
      </div>
    </section>
  );
}

// ============================================================================
// Engineering quality gates (collapsed) + legacy section (collapsed)
// ============================================================================

function VerdictTile({ verdict }: { verdict: Verdict }) {
  const palette: Record<VerdictStatus, { icon: string; label: string; cls: string }> = {
    pass: {
      icon: '✓',
      label: 'Pass',
      cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
    },
    fail: { icon: '✗', label: 'Fail', cls: 'border-red-500/40 bg-red-500/10 text-red-300' },
    pending: {
      icon: '⏳',
      label: 'Pending',
      cls: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
    },
    error: {
      icon: '!',
      label: 'Error',
      cls: 'border-orange-500/40 bg-orange-500/10 text-orange-300',
    },
  };
  const p = palette[verdict.status];
  const runAt = verdict.source?.runAt;
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {verdict.id.toUpperCase()}
        </p>
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${p.cls}`}
        >
          <span aria-hidden>{p.icon}</span>
          {p.label}
        </span>
      </div>
      <p className="mt-2 text-sm font-semibold">{verdict.title}</p>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{verdict.headline}</p>
      {runAt ? (
        <p className="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground">
          source run {new Date(runAt).toLocaleDateString()}
        </p>
      ) : null}
    </div>
  );
}

function VerdictsBlock() {
  const ids = ['b1', 'b3', 'b6', 'b7', 'b8', 'b11'];
  const verdicts = ids.map((id) => loadVerdict(id)).filter((v): v is Verdict => v !== null);
  if (verdicts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No verdict files in{' '}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">apps/web/public/benchmarks/</code>{' '}
        yet. Run{' '}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">
          pnpm --filter @chessco/workers bench:verdicts
        </code>
        .
      </p>
    );
  }
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {verdicts.map((v) => (
        <VerdictTile key={v.id} verdict={v} />
      ))}
    </div>
  );
}

function LegacyBlock({ benchmark }: { benchmark: LegacyBenchmark }) {
  const runDate = new Date(benchmark.run_at);
  return (
    <div>
      <p className="text-sm text-muted-foreground">
        Earlier methodology (position-tree overlap with recency weighting). Superseded by the sparse
        cascade above; kept for comparison only.
      </p>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <Stat
          label="Quick scan"
          value={`${int(benchmark.guidance.quick_scan_games)} games`}
          detail={benchmark.guidance.thresholds.quick_scan}
        />
        <Stat
          label="Recommended"
          value={`${int(benchmark.guidance.recommended_games)} games`}
          detail={benchmark.guidance.thresholds.recommended}
        />
        <Stat
          label="High-confidence"
          value={`${int(benchmark.guidance.high_confidence_games)} games`}
          detail={benchmark.guidance.thresholds.high_confidence}
        />
      </div>
      <div className="mt-4 overflow-hidden rounded-md border border-border">
        <div className="border-b border-border bg-card px-4 py-2">
          <p className="text-xs text-muted-foreground">
            Last run:{' '}
            {Number.isFinite(runDate.getTime()) ? runDate.toLocaleString() : benchmark.run_at}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-muted/40 text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Games</th>
                <th className="px-4 py-3 font-medium">Trials</th>
                <th className="px-4 py-3 font-medium">Top 1</th>
                <th className="px-4 py-3 font-medium">Top 3</th>
                <th className="px-4 py-3 font-medium">Top 5</th>
                <th className="px-4 py-3 font-medium">Top 10</th>
                <th className="px-4 py-3 font-medium">Median rank</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {benchmark.metrics_by_sample_size.map(({ sample_size, metrics }) => (
                <tr key={sample_size} className="bg-background">
                  <td className="px-4 py-3 font-medium">{sample_size}</td>
                  <td className="px-4 py-3">{num(metrics.n)}</td>
                  <td className="px-4 py-3">{pct(metrics.top1)}</td>
                  <td className="px-4 py-3">{pct(metrics.top3)}</td>
                  <td className="px-4 py-3">{pct(metrics.top5)}</td>
                  <td className="px-4 py-3">{pct(metrics.top10)}</td>
                  <td className="px-4 py-3">{metrics.median_rank ?? 'n/a'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function EngineeringFooter({ legacy }: { legacy: LegacyBenchmark | null }) {
  return (
    <footer className="mt-20 border-t border-border pt-8">
      <details className="group">
        <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
          Engineering quality gates (CQ-1 · CQ-2)
        </summary>
        <div className="mt-4">
          <VerdictsBlock />
        </div>
      </details>

      {legacy ? (
        <details className="group mt-4">
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
            Legacy repertoire-vector matcher (superseded)
          </summary>
          <div className="mt-4">
            <LegacyBlock benchmark={legacy} />
          </div>
        </details>
      ) : null}
    </footer>
  );
}

// ============================================================================
// Missing-artifact fallback
// ============================================================================

function MissingBenchmark() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-16">
      <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
        Chessco
      </Link>
      <h1 className="mt-8 font-display text-4xl font-semibold">How chessco works</h1>
      <p className="mt-4 max-w-2xl text-muted-foreground">
        No benchmark artifact has been published yet. Generate one from the worker package and this
        page will render the measured numbers automatically.
      </p>
      <pre className="mt-8 overflow-x-auto rounded-md border border-border bg-card p-4 text-xs text-muted-foreground">
        {`# Daily refresh (also runs in .github/workflows/daily-benchmarks.yml):
pnpm --filter @chessco/workers eval:coverage
pnpm --filter @chessco/workers eval:cascade`}
      </pre>
    </main>
  );
}

// ============================================================================
// Page
// ============================================================================

export default async function BenchmarksPage() {
  const sparse = loadJson<SparseBenchmark>(['sparse-cascade-benchmark.json']);
  const legacy = loadJson<LegacyBenchmark>(['repertoire-benchmark.json']);
  const coverage = loadJson<CoverageStats>(['coverage-stats.json']);
  const anyVerdict = ['b1', 'b3', 'b6', 'b7', 'b8', 'b11'].some((id) => loadVerdict(id) !== null);
  if (!sparse && !legacy && !coverage && !anyVerdict) return <MissingBenchmark />;

  const indexStats = await getIndexStats();
  const refresh = latestRefresh(coverage, sparse);

  return (
    <main className="mx-auto max-w-6xl px-4 py-12 md:py-16">
      <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
        Chessco
      </Link>

      <HeroSection coverage={coverage} sparse={sparse} refresh={refresh} />
      <ScoutStage coverage={coverage} sparse={sparse} indexStats={indexStats} />
      <TreeStage />
      <LeaksStage />
      <PracticeStage />
      <LiveChessStage />
      <EngineeringFooter legacy={legacy} />
    </main>
  );
}
