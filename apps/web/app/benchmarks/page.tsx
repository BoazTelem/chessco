import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Benchmarks',
  description: 'Chessco matcher benchmark results and methodology.',
};

// ============================================================================
// Verdict tiles (B1 / B3 / B11 …) — read from apps/web/public/benchmarks/*.json
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

function loadVerdict(id: string): Verdict | null {
  const candidates = [
    join(process.cwd(), 'public', 'benchmarks', `${id}.json`),
    join(process.cwd(), 'apps', 'web', 'public', 'benchmarks', `${id}.json`),
  ];
  const path = candidates.find((p) => existsSync(p));
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Verdict;
  } catch {
    return null;
  }
}

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

function VerdictsSection() {
  const ids = ['b1', 'b3', 'b6', 'b7', 'b8', 'b11'];
  const verdicts = ids.map((id) => loadVerdict(id)).filter((v): v is Verdict => v !== null);

  if (verdicts.length === 0) {
    return (
      <section className="mt-8 rounded-md border border-dashed border-border bg-card p-5">
        <h2 className="font-display text-lg font-semibold">Benchmark verdicts</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          No verdict files in{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">apps/web/public/benchmarks/</code>{' '}
          yet. Run{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            pnpm --filter @chessco/workers bench:verdicts
          </code>{' '}
          to populate them, or run the full{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">bench:all</code> to refresh source
          artifacts first.
        </p>
      </section>
    );
  }

  return (
    <section className="mt-10">
      <header className="flex items-baseline justify-between">
        <h2 className="font-display text-xl font-semibold">Critical-quality benchmark verdicts</h2>
        <p className="text-xs text-muted-foreground">
          Pass/fail vs. plan-locked CQ-1 and CQ-2 targets
        </p>
      </header>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        {verdicts.map((v) => (
          <VerdictTile key={v.id} verdict={v} />
        ))}
      </div>
    </section>
  );
}

// ============================================================================
// Sparse cascade benchmark (v4 matcher — the current production path)
// ============================================================================

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

function loadSparseBenchmark(): SparseBenchmark | null {
  const candidates = [
    join(process.cwd(), 'public', 'sparse-cascade-benchmark.json'),
    join(process.cwd(), 'apps', 'web', 'public', 'sparse-cascade-benchmark.json'),
  ];
  const path = candidates.find((p) => existsSync(p));
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SparseBenchmark;
  } catch {
    return null;
  }
}

// ============================================================================
// Legacy repertoire-vector benchmark (kept for comparison; superseded by v4)
// ============================================================================

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

function loadLegacyBenchmark(): LegacyBenchmark | null {
  const candidates = [
    join(process.cwd(), 'public', 'repertoire-benchmark.json'),
    join(process.cwd(), 'apps', 'web', 'public', 'repertoire-benchmark.json'),
  ];
  const path = candidates.find((p) => existsSync(p));
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LegacyBenchmark;
  } catch {
    return null;
  }
}

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

// ============================================================================
// Sparse cascade benchmark section (primary)
// ============================================================================

function SparseSection({ benchmark }: { benchmark: SparseBenchmark }) {
  const runDate = new Date(benchmark.ts);
  const latest = benchmark.metrics_by_sample_size.at(-1);
  const corpusTotal = Object.values(benchmark.corpus_size).reduce((a, b) => a + b, 0);

  return (
    <section className="mt-12">
      <header>
        <h2 className="font-display text-2xl font-semibold md:text-3xl">
          Sparse cascade matcher (v4)
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          Production methodology. Stage A SQL prefilter → Stage B sparse term retrieval over{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">fingerprint_terms</code> → Stage C
          combined-score re-rank. Sample N games from a known target, run the cascade, record where
          the target ranked.
        </p>
      </header>

      <div className="mt-6 grid gap-3 md:grid-cols-3">
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
          label="High-confidence mode"
          value={`${int(benchmark.guidance.high_confidence)} games`}
          detail={benchmark.guidance.rules.high_confidence}
        />
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-4">
        <Stat label="Fingerprinted handles" value={num(corpusTotal)} detail="all platforms" />
        {Object.entries(benchmark.corpus_size).map(([plat, n]) => (
          <Stat key={plat} label={`${plat} fingerprints`} value={num(n)} />
        ))}
        <Stat label="Total trials" value={num(benchmark.total_trials)} />
      </div>

      <div className="mt-8 overflow-hidden rounded-md border border-border">
        <div className="border-b border-border bg-card px-4 py-3">
          <h3 className="font-display text-lg font-semibold">Accuracy by sample size</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Last run: {Number.isFinite(runDate.getTime()) ? runDate.toLocaleString() : benchmark.ts}
            {' · '}duration {Math.round(benchmark.duration_seconds / 60)} min
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
      </div>

      {benchmark.metrics_by_platform ? (
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {Object.entries(benchmark.metrics_by_platform).map(([plat, rows]) => (
            <div key={plat} className="overflow-hidden rounded-md border border-border">
              <div className="border-b border-border bg-card px-4 py-2">
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

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <div className="rounded-md border border-border bg-card p-5">
          <h3 className="font-display text-lg font-semibold">Methodology</h3>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            For {num(benchmark.total_targets)} random fingerprinted handles, we sample N games and
            ask the cascade matcher to identify the target. The target&apos;s own fingerprint stays
            in the candidate pool — this mirrors production, where every match is against handles
            whose fingerprints we&apos;ve crawled. We record the rank the cascade gave the
            target&apos;s handle (or &quot;missed&quot; if outside top-{benchmark.config.top_k}).
          </p>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Config: {benchmark.config.platform} platform, sample sizes{' '}
            {benchmark.config.sample_sizes.join(', ')}, seeds {benchmark.config.seeds.join(', ')},
            top-K {benchmark.config.top_k}.
          </p>
        </div>
        <div className="rounded-md border border-border bg-card p-5">
          <h3 className="font-display text-lg font-semibold">Current read</h3>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            {latest
              ? `At ${latest.sample_size} sampled games, the cascade reached ${pct(
                  latest.metrics.top1,
                )} top-1 and ${pct(latest.metrics.top10)} top-10 accuracy.`
              : 'No sample-size metrics were recorded in this artifact.'}
          </p>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            The UI should only promise game counts that this page can support with measured data.
          </p>
        </div>
      </div>
    </section>
  );
}

// ============================================================================
// Legacy repertoire benchmark section (superseded; kept for comparison)
// ============================================================================

function LegacySection({ benchmark }: { benchmark: LegacyBenchmark }) {
  const runDate = new Date(benchmark.run_at);

  return (
    <section className="mt-16 border-t border-border pt-10">
      <header>
        <h2 className="font-display text-xl font-semibold text-muted-foreground">
          Legacy repertoire-vector matcher
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          Earlier methodology (position-tree overlap with recency weighting). Superseded by the
          sparse cascade above. Retained for comparison; product copy should rely on the cascade
          numbers.
        </p>
      </header>

      <div className="mt-6 grid gap-3 md:grid-cols-3">
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
          label="High-confidence mode"
          value={`${int(benchmark.guidance.high_confidence_games)} games`}
          detail={benchmark.guidance.thresholds.high_confidence}
        />
      </div>

      <div className="mt-6 overflow-hidden rounded-md border border-border">
        <div className="border-b border-border bg-card px-4 py-3">
          <h3 className="font-display text-sm font-semibold text-muted-foreground">
            Accuracy by sample size
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
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
    </section>
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
      <h1 className="mt-8 font-display text-4xl font-semibold">Matcher benchmarks</h1>
      <p className="mt-4 max-w-2xl text-muted-foreground">
        No benchmark artifact has been published yet. Generate one from the worker package and this
        page will render the measured game-count guidance automatically.
      </p>
      <pre className="mt-8 overflow-x-auto rounded-md border border-border bg-card p-4 text-xs text-muted-foreground">
        {`# v4 sparse cascade (current production matcher)
pnpm --filter @chessco/workers eval:cascade

# legacy repertoire-vector (kept for comparison)
pnpm --filter @chessco/workers eval:repertoire`}
      </pre>
    </main>
  );
}

// ============================================================================
// Page
// ============================================================================

export default function BenchmarksPage() {
  const sparse = loadSparseBenchmark();
  const legacy = loadLegacyBenchmark();
  const anyVerdict = ['b1', 'b3', 'b6', 'b7', 'b8', 'b11'].some((id) => loadVerdict(id) !== null);
  if (!sparse && !legacy && !anyVerdict) return <MissingBenchmark />;

  return (
    <main className="mx-auto max-w-6xl px-4 py-12 md:py-16">
      <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
        Chessco
      </Link>

      <section className="mt-8">
        <h1 className="font-display text-4xl font-semibold md:text-5xl">Matcher benchmarks</h1>
        <p className="mt-4 max-w-3xl text-base leading-7 text-muted-foreground">
          These results measure how reliably Chessco recovers a known target&apos;s handle from a
          small PGN sample of their games. The benchmark exists so product copy can promise game
          counts based on evidence, not guesswork.
        </p>
      </section>

      <VerdictsSection />

      {sparse ? <SparseSection benchmark={sparse} /> : null}
      {legacy ? <LegacySection benchmark={legacy} /> : null}
    </main>
  );
}
