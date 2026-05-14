import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Benchmarks',
  description: 'Chessco repertoire matcher benchmark results and methodology.',
};

type Metrics = {
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

type Benchmark = {
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
  metrics_by_sample_size: Array<{ sample_size: number; metrics: Metrics }>;
};

function loadBenchmark(): Benchmark | null {
  const candidates = [
    join(process.cwd(), 'public', 'repertoire-benchmark.json'),
    join(process.cwd(), 'apps', 'web', 'public', 'repertoire-benchmark.json'),
  ];
  const path = candidates.find((p) => existsSync(p));
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Benchmark;
  } catch {
    return null;
  }
}

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

function MissingBenchmark() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-16">
      <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
        Chessco
      </Link>
      <h1 className="mt-8 font-display text-4xl font-semibold">Repertoire matcher benchmarks</h1>
      <p className="mt-4 max-w-2xl text-muted-foreground">
        No benchmark artifact has been published yet. Generate one from the worker package and this
        page will render the measured game-count guidance automatically.
      </p>
      <pre className="mt-8 overflow-x-auto rounded-md border border-border bg-card p-4 text-xs text-muted-foreground">
        pnpm --filter @chessco/workers eval:repertoire
      </pre>
    </main>
  );
}

export default function BenchmarksPage() {
  const benchmark = loadBenchmark();
  if (!benchmark) return <MissingBenchmark />;

  const runDate = new Date(benchmark.run_at);
  const latest = benchmark.metrics_by_sample_size.at(-1);

  return (
    <main className="mx-auto max-w-6xl px-4 py-12 md:py-16">
      <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
        Chessco
      </Link>

      <section className="mt-8">
        <h1 className="font-display text-4xl font-semibold md:text-5xl">
          Repertoire matcher benchmarks
        </h1>
        <p className="mt-4 max-w-3xl text-base leading-7 text-muted-foreground">
          These results measure whether Chessco can recover an account from held-out games that are
          excluded from that account&apos;s candidate repertoire. The benchmark exists so product
          copy can say the right number of PGNs based on evidence, not guesswork.
        </p>
      </section>

      <section className="mt-8 grid gap-3 md:grid-cols-3">
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
      </section>

      <section className="mt-8 grid gap-3 md:grid-cols-4">
        <Stat label="Eligible accounts" value={num(benchmark.corpus.eligible_accounts)} />
        <Stat label="Game rows loaded" value={num(benchmark.corpus.raw_game_rows_loaded)} />
        <Stat label="Move rows loaded" value={num(benchmark.corpus.moves_loaded)} />
        <Stat label="Repertoire keys" value={num(benchmark.corpus.vector_keys)} />
      </section>

      <section className="mt-10 overflow-hidden rounded-md border border-border">
        <div className="border-b border-border bg-card px-4 py-3">
          <h2 className="font-display text-lg font-semibold">Accuracy by sample size</h2>
          <p className="mt-1 text-sm text-muted-foreground">
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
                <th className="px-4 py-3 font-medium">Top-1 false positive</th>
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
                  <td className="px-4 py-3">{pct(metrics.false_positive_rate_top1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-10 grid gap-4 md:grid-cols-2">
        <div className="rounded-md border border-border bg-card p-5">
          <h2 className="font-display text-lg font-semibold">Methodology</h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{benchmark.methodology}</p>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Config: depth {benchmark.config.depth}, min train games{' '}
            {benchmark.config.min_train_games}, seeds {benchmark.config.seeds.join(', ')}, platform{' '}
            {benchmark.config.platform ?? 'all'}.
          </p>
        </div>
        <div className="rounded-md border border-border bg-card p-5">
          <h2 className="font-display text-lg font-semibold">Current read</h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            {latest
              ? `At ${latest.sample_size} held-out games, the benchmark reached ${pct(
                  latest.metrics.top1,
                )} top-1 and ${pct(latest.metrics.top10)} top-10 accuracy.`
              : 'No sample-size metrics were recorded in this artifact.'}
          </p>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            The UI should only promise game counts that this page can support with measured data.
          </p>
        </div>
      </section>
    </main>
  );
}
