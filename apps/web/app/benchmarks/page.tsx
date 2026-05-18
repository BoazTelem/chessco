import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getIndexStats } from '@/lib/index-stats';
import { getCoverageArtifact, getSparseCascadeArtifact, getLegacyArtifact } from '@/lib/benchmarks';

export const metadata: Metadata = {
  title: 'How chessco works',
  description:
    'Scout an opponent, build their opening tree, find their leaks, and prepare with bots, positions, or coaches. Coverage and accuracy benchmarks updated daily.',
};

// ============================================================================
// File-based loaders: bundled JSON in apps/web/public/. Used as fallback when
// Supabase has no row for an artifact kind yet (pre-first-run) and for build
// verdicts that aren't kept in the DB. Live coverage + cascade are read via
// the Supabase-backed loaders in @/lib/benchmarks.
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
  /** Prep audience aggregate. Optional for backward-compat with artifacts written
   *  before the audience block was added (computed from tiers below if absent). */
  audience?: {
    label: string;
    pool: number;
    claimed: number;
    coverage_pct: number;
  };
  tiers: CoverageTier[];
};

/** Sum of distinct claimed across non-overlapping FIDE rating bands ÷ 1400+ pool.
 *  Used when the artifact predates the `audience` block. The four FIDE bands
 *  (2200+ / 2000-2199 / 1800-1999 / 1400-1799) are mutually exclusive, so
 *  summing claimed_total counts distinct FIDE players. The Titled axis is
 *  intentionally excluded (it overlaps with 2200+). */
function deriveAudience(coverage: CoverageStats): {
  pool: number;
  claimed: number;
  coverage_pct: number;
} {
  if (coverage.audience) {
    return {
      pool: coverage.audience.pool,
      claimed: coverage.audience.claimed,
      coverage_pct: coverage.audience.coverage_pct,
    };
  }
  const pool = coverage.totals.fide_pool_1400_plus;
  const claimed = coverage.tiers
    .filter((t) => !t.label.toLowerCase().startsWith('titled'))
    .reduce((acc, t) => acc + t.claimed_total, 0);
  const coverage_pct = pool > 0 ? Number(((claimed / pool) * 100).toFixed(2)) : 0;
  return { pool, claimed, coverage_pct };
}

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

function pickLatest(candidates: Array<string | undefined | null>): string | null {
  let best: string | null = null;
  let bestT = -Infinity;
  for (const d of candidates) {
    if (!d) continue;
    const t = new Date(d).getTime();
    if (Number.isFinite(t) && t > bestT) {
      best = d;
      bestT = t;
    }
  }
  return best;
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

function CoverageBar({ current }: { current: number }) {
  const fillPct = Math.min(100, Math.max(0, current));
  return (
    <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full bg-emerald-500/70" style={{ width: `${fillPct}%` }} />
    </div>
  );
}

// ============================================================================
// Hero: product story in 30 seconds + summary proof tiles
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
  const audience = coverage ? deriveAudience(coverage) : null;
  const tenGameRow =
    sparse?.metrics_by_sample_size.find((r) => r.sample_size === 10) ??
    sparse?.metrics_by_sample_size.at(-1) ??
    null;

  return (
    <section className="mt-10">
      <header className="max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">How it works</p>
        <h1 className="mt-2 font-display text-4xl font-semibold md:text-5xl">
          From a name to a prepared game, in five steps.
        </h1>
        <p className="mt-4 text-base leading-7 text-muted-foreground md:text-lg">
          Search any tournament player → find their online account on chess.com or Lichess → build
          their opening tree from real games → compare it to yours and surface their leaks → prepare
          by playing their imitating bot, drilling positions, or booking a coach.
        </p>
      </header>

      <div className="mt-6 flex flex-wrap gap-2">
        <StagePill n={1} title="Find the player" href="#stage-find" />
        <StagePill n={2} title="Scout their account" href="#stage-scout" />
        <StagePill n={3} title="Build their tree" href="#stage-tree" />
        <StagePill n={4} title="Find the leaks" href="#stage-leaks" />
        <StagePill n={5} title="Prepare" href="#stage-practice" />
      </div>

      <div className="mt-8 grid gap-3 md:grid-cols-3">
        <div className="rounded-md border border-accent/40 bg-accent/5 p-4">
          <p className="text-xs uppercase tracking-wide text-accent">Name coverage</p>
          {audience ? (
            <>
              <p className="mt-2 text-3xl font-semibold">{audience.coverage_pct.toFixed(1)}%</p>
              <p className="mt-1 text-xs text-muted-foreground">
                of ~{num(audience.pool)} tournament players matched to a chess.com or Lichess
                account. Try a name search first. It&apos;s quick, and if you&apos;re in here
                you&apos;re done.
              </p>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">Coverage benchmark pending.</p>
          )}
        </div>

        <div className="rounded-md border border-border bg-card p-4">
          <p className="text-xs uppercase tracking-wide text-foreground">Games coverage</p>
          {tenGameRow ? (
            <>
              <p className="mt-2 text-3xl font-semibold">{pct(tenGameRow.metrics.top1)}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Not found by name? Paste their games and we identify them by game fingerprint. With{' '}
                {tenGameRow.sample_size} games we name them on the first try this often (
                {pct(tenGameRow.metrics.top10)} in the top 10). The more games you paste, the surer
                the match.
              </p>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">Cascade benchmark pending.</p>
          )}
        </div>

        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-4">
          <p className="text-xs uppercase tracking-wide text-emerald-300">Last refresh</p>
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
                These numbers re-measure every night, so what you see here is yesterday&apos;s
                truth, not a marketing screenshot from last quarter.
              </p>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              Numbers re-measure nightly so this page stays honest.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

// ============================================================================
// Stage 1: Find (federation lookup; ad-hoc by name + rating when missing)
// ============================================================================

function FindStage({ indexStats }: { indexStats: Awaited<ReturnType<typeof getIndexStats>> }) {
  const platformHandles = indexStats.chesscomHandles + indexStats.lichessHandles;
  const totalGames = indexStats.chesscomGames + indexStats.lichessGames;

  return (
    <section id="stage-find" className="mt-16 scroll-mt-16 border-t border-border pt-10">
      <header className="max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Stage 1</p>
        <h2 className="mt-1 font-display text-2xl font-semibold md:text-3xl">
          Find: locate them in the tournament pool.
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Start by name. Filter by federation (FIDE / ICF / USCF), title (GM / IM / FM / …),
          country, and rating range. The index is built from official federation rosters, so every
          tournament-rated player is in scope, not just titled GMs. If they aren&apos;t in any
          federation roster, type the name and rating to add them as an ad-hoc target;
          community-verified ad-hoc players then appear for the next searcher.
        </p>
      </header>

      <div className="mt-4 flex flex-wrap gap-3">
        <Link
          href="/scout"
          className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground hover:opacity-90"
        >
          Open Scout →
        </Link>
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
          <h3 className="font-display text-lg font-semibold">Not in any federation roster?</h3>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Type the player&apos;s name and rating to add them as an ad-hoc target. They become
            searchable for the next person looking, and once another user verifies the entry the
            target promotes to community-confirmed. Useful for juniors, unrated club players, and
            players from federations not yet covered.
          </p>
        </div>
        <div className="rounded-md border border-border bg-card p-5">
          <h3 className="font-display text-lg font-semibold">Tournament games come to you.</h3>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            We auto-ingest Lichess broadcast tournaments every 30 minutes. If your opponent played a
            broadcast event (a Grand Prix, a national championship, a weekend open with live relay),
            their games are already in the corpus the moment you search them. No PGN upload needed
            for those games.
          </p>
        </div>
      </div>
    </section>
  );
}

// ============================================================================
// Stage 2: Scout (match the tournament player to a chess.com / Lichess account)
// ============================================================================

function ScoutStage({
  coverage,
  sparse,
}: {
  coverage: CoverageStats | null;
  sparse: SparseBenchmark | null;
}) {
  return (
    <section id="stage-scout" className="mt-16 scroll-mt-16 border-t border-border pt-10">
      <header className="max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Stage 2</p>
        <h2 className="mt-1 font-display text-2xl font-semibold md:text-3xl">
          Scout: match them to an online account.
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          A tournament name alone isn&apos;t enough. We need their chess.com or Lichess account to
          pull real games for the next stages. Two paths get us there.
        </p>
      </header>

      <div className="mt-4 flex flex-wrap gap-3">
        <a
          href="#stage-scout-coverage"
          className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm hover:border-accent hover:text-accent"
        >
          See coverage by tier ↓
        </a>
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <div className="rounded-md border border-border bg-card p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">
            Path 1: By name
          </p>
          <h3 className="mt-2 font-display text-lg font-semibold">Match a claimed account.</h3>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            If the player has linked a chess.com or Lichess account to their FIDE / ICF / USCF
            profile, it shows up directly. The coverage table below reports what fraction of the
            tournament pool is matchable this way, by rating band.
          </p>
        </div>
        <div className="rounded-md border border-border bg-card p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">
            Path 2: By PGN
          </p>
          <h3 className="mt-2 font-display text-lg font-semibold">Paste a few of their games.</h3>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            If they haven&apos;t claimed an account, paste a handful of their games. The sparse
            cascade matches on opening repertoire and tempo signature, regardless of how anonymous
            the handle is. Accuracy table below shows how many games you need.
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
            Club players matter as much as GMs. We benchmark coverage at every rating band, not just
            titled players.
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
              <th className="w-1/3 px-4 py-3 font-medium">Progress</th>
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
                <td className="px-4 py-3">
                  <CoverageBar current={tier.coverage_pct} />
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
            For {num(benchmark.total_targets)} random players we hand the matcher N of their games
            and check whether it names them. {num(corpusTotal)} players indexed across chess.com +
            Lichess.
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
        Last full run took {Math.round(benchmark.duration_seconds / 60)} min on{' '}
        {num(benchmark.total_trials)} trials.
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
// Stage 3: Build their opening tree
// ============================================================================

function TreeStage() {
  return (
    <section id="stage-tree" className="mt-16 scroll-mt-16 border-t border-border pt-10">
      <header className="max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Stage 3</p>
        <h2 className="mt-1 font-display text-2xl font-semibold md:text-3xl">
          Build their opening tree.
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Once we know which handle is theirs, the worker walks every game we have for them and
          builds two trees: a shallow depth-12 tree the matcher uses, and a deep depth-30 tree the
          prep UI shows you. Split by color (their white repertoire and their black repertoire are
          separate), recency-weighted so what they played last month counts more than what they
          played three years ago.
        </p>
      </header>

      <div className="mt-6 grid gap-3 md:grid-cols-3">
        <Stat
          label="Matcher"
          value="Shallow"
          detail="Quick enough to fingerprint every player in the corpus (12 plies)."
        />
        <Stat
          label="Prep view"
          value="Deep"
          detail="Deep enough to play out a real opening line (30 plies)."
        />
        <Stat label="Refresh" value="Auto" detail="Rebuilds whenever new games come in." />
      </div>

      <p className="mt-6 text-sm text-muted-foreground">
        The 30-ply tree, split by color and recency-weighted, is what you walk through in the prep
        UI.{' '}
        <Link href="/prepare" className="text-accent hover:underline">
          See it on /prepare →
        </Link>
      </p>
    </section>
  );
}

// ============================================================================
// Stage 4: Leaks
// ============================================================================

function LeaksStage() {
  return (
    <section id="stage-leaks" className="mt-16 scroll-mt-16 border-t border-border pt-10">
      <header className="max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Stage 4</p>
        <h2 className="mt-1 font-display text-2xl font-semibold md:text-3xl">
          Find their leaks by comparing their tree to yours.
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
            <strong className="text-foreground">Your reach.</strong> How often your repertoire
            actually reaches the position. A leak in a line you never play is noise.
          </li>
          <li className="px-4 py-3">
            <strong className="text-foreground">Their reach.</strong> How often they let it happen.
            Once-in-fifty isn&apos;t a leak.
          </li>
          <li className="px-4 py-3">
            <strong className="text-foreground">Bad-move share.</strong> What fraction of their
            replies in that position the engine flags as mistakes or blunders (avg CP loss ≥ 100,
            high mistake / blunder rate).
          </li>
          <li className="px-4 py-3">
            <strong className="text-foreground">Severity.</strong> How badly engines rate the bad
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
    </section>
  );
}

// ============================================================================
// Stage 5: Practice
// ============================================================================

function PracticeStage() {
  return (
    <section id="stage-practice" className="mt-16 scroll-mt-16 border-t border-border pt-10">
      <header className="max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Stage 5</p>
        <h2 className="mt-1 font-display text-2xl font-semibold md:text-3xl">
          Prepare: bots, positions, coaches.
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
            Maia-powered bots that play like a human at a given strength, not a stockfish-with-the-
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
            on the waitlist. Join from the home pillar tile.
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
  // Supabase-first: eval workers publish into benchmark_artifacts; the page
  // reads the latest row per kind via the anon client. Fall back to the
  // bundled JSON in apps/web/public/ so the page still renders if Supabase
  // is empty (pre-first-run) or unreachable.
  const [coverageArtifact, sparseArtifact, legacyArtifact, indexStats] = await Promise.all([
    getCoverageArtifact<CoverageStats>(),
    getSparseCascadeArtifact<SparseBenchmark>(),
    getLegacyArtifact<LegacyBenchmark>(),
    getIndexStats(),
  ]);

  const coverage = coverageArtifact?.data ?? loadJson<CoverageStats>(['coverage-stats.json']);
  const sparse =
    sparseArtifact?.data ?? loadJson<SparseBenchmark>(['sparse-cascade-benchmark.json']);
  const legacy = legacyArtifact?.data ?? loadJson<LegacyBenchmark>(['repertoire-benchmark.json']);
  const anyVerdict = ['b1', 'b3', 'b6', 'b7', 'b8', 'b11'].some((id) => loadVerdict(id) !== null);
  if (!sparse && !legacy && !coverage && !anyVerdict) return <MissingBenchmark />;

  // Prefer the DB row's refreshed_at over the payload's internal as_of/ts so
  // the "last refresh" badge reflects when the page actually got new data.
  const refresh =
    pickLatest([coverageArtifact?.refreshedAt, sparseArtifact?.refreshedAt]) ??
    latestRefresh(coverage, sparse);

  return (
    <main className="mx-auto max-w-6xl px-4 py-12 md:py-16">
      <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
        Chessco
      </Link>

      <HeroSection coverage={coverage} sparse={sparse} refresh={refresh} />
      <FindStage indexStats={indexStats} />
      <ScoutStage coverage={coverage} sparse={sparse} />
      <TreeStage />
      <LeaksStage />
      <PracticeStage />
      {process.env.SHOW_DEV_BENCHMARKS === '1' ? <EngineeringFooter legacy={legacy} /> : null}
    </main>
  );
}
