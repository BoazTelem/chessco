/**
 * Sparse cascade benchmark — measures the v4 matcher (Stage A SQL prefilter
 * → Stage B sparse term retrieval → Stage C combined-score re-rank) end-to-
 * end against the populated account_fingerprints + fingerprint_terms tables.
 *
 * Methodology:
 *   For N random fingerprinted handles (target):
 *     For each sample_size in [3, 5, 10, 20]:
 *       For each seed in [1, 2, 3]:
 *         · sample sample_size games from the target's known games
 *         · extract features + terms from the sample (the "query PGN")
 *         · rankFingerprints(query) → top-K candidates
 *         · record where the true target's handle ranked
 *
 * Mirrors the product flow: a user pastes a small PGN sample of some real
 * player, the matcher asks "which online handle is this?" — except here we
 * know the answer in advance, so we can score.
 *
 * Aggregates per sample_size:
 *   top-1, top-3, top-10 accuracy
 *   median rank, MRR (mean reciprocal rank)
 *   trial count
 *
 * Derived guidance (per docs/repertoire-matcher-benchmark.md tier rules):
 *   quick_scan       = smallest sample_size with top-10 >= 50%
 *   recommended      = smallest sample_size with top-3  >= 70%
 *   high_confidence  = smallest sample_size with top-1  >= 75%
 *
 * Note on the v1 methodology: the target's own full fingerprint stays in
 * account_fingerprints during the trial. We're not simulating "the target
 * is unknown" — we're asking "given N sampled games, does the cascade
 * still surface the target's stored fingerprint at the top?". That's the
 * production question: every match is against handles whose fingerprints
 * we crawled. A future v2 could add target-fingerprint rebuild-from-
 * remaining-games (closer to a pure leave-N-out) but adds DB mutation
 * complexity for limited additional signal.
 *
 * Usage:
 *   pnpm --filter @chessco/workers eval:cascade
 *   pnpm --filter @chessco/workers eval:cascade -- --limit 100
 *   pnpm --filter @chessco/workers eval:cascade -- --sample-sizes 5,10,15,30
 *   pnpm --filter @chessco/workers eval:cascade -- --seeds 1,2,3,4,5
 *   pnpm --filter @chessco/workers eval:cascade -- --platform lichess
 *   pnpm --filter @chessco/workers eval:cascade -- --out apps/web/public/sparse-cascade-benchmark.json
 */
import 'dotenv/config';
import { Chess } from 'chess.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { getGamesDb } from '../db';
import { extractFeaturesV0, type GameRow } from '../features/extract';
import { rankFingerprints, type Stage3Match } from '../stage3/match';
import { publishBenchmarkArtifact } from './publish';

// process.cwd() under `pnpm --filter` is apps/workers/, not the repo root,
// which made the default --out resolve to apps/workers/apps/web/public/...
// Resolve against this file's location instead: src/eval/ → repo root is 4
// levels up (apps/workers/src/eval/ → chessco/).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const DEFAULT_OUT = path.resolve(REPO_ROOT, 'apps/web/public/sparse-cascade-benchmark.json');

const DEFAULT_LIMIT = 200;
const DEFAULT_SAMPLE_SIZES = [3, 5, 10, 20];
const DEFAULT_SEEDS = [1, 2, 3];
const DEFAULT_TOP_K = 50;
const MIN_TRAIN_GAMES = 10;
const MOVE_SEQ_PLY_COUNT = 12;

interface CliArgs {
  limit: number;
  sampleSizes: number[];
  seeds: number[];
  topK: number;
  platform: 'both' | 'chess.com' | 'lichess';
  out: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    limit: DEFAULT_LIMIT,
    sampleSizes: DEFAULT_SAMPLE_SIZES,
    seeds: DEFAULT_SEEDS,
    topK: DEFAULT_TOP_K,
    platform: 'both',
    out: DEFAULT_OUT,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit' && argv[i + 1]) out.limit = Number.parseInt(argv[++i]!, 10);
    else if (a === '--sample-sizes' && argv[i + 1]) {
      // Accept comma- or whitespace-separated values so the CLI works whether
      // PS passed "3,5,10" (kept literal) or split into "3 5 10".
      out.sampleSizes = argv[++i]!.split(/[\s,]+/)
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
    } else if (a === '--seeds' && argv[i + 1]) {
      out.seeds = argv[++i]!.split(/[\s,]+/)
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n));
    } else if (a === '--top-k' && argv[i + 1]) {
      out.topK = Number.parseInt(argv[++i]!, 10);
    } else if (a === '--platform' && argv[i + 1]) {
      const p = argv[++i]!;
      if (p !== 'chess.com' && p !== 'lichess' && p !== 'both') {
        throw new Error(`--platform must be chess.com|lichess|both (got ${p})`);
      }
      out.platform = p as CliArgs['platform'];
    } else if (a === '--out' && argv[i + 1]) {
      // Resolve against repo root for stable behaviour under `pnpm --filter`.
      out.out = path.resolve(REPO_ROOT, argv[++i]!);
    } else throw new Error(`Unrecognized arg: ${a}`);
  }
  return out;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

/** Mulberry32 — deterministic PRNG for reproducible samples. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleN<T>(arr: T[], n: number, seed: number): T[] {
  if (n >= arr.length) return arr.slice();
  const rng = makeRng(seed);
  const idx = arr.map((_, i) => i);
  // Fisher-Yates partial shuffle: pull n random indices to the tail.
  for (let i = idx.length - 1; i > idx.length - 1 - n; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return idx.slice(idx.length - n).map((i) => arr[i]!);
}

function pgnToMoveSeqPrefix(pgn: string | null, n = MOVE_SEQ_PLY_COUNT): string {
  if (!pgn || pgn.length === 0) return '';
  const chess = new Chess();
  try {
    chess.loadPgn(pgn, { strict: false });
  } catch {
    return '';
  }
  const history = chess.history();
  if (history.length === 0) return '';
  return history.slice(0, n).join(' ');
}

interface BenchTarget {
  handle_id: string;
  platform: 'chess.com' | 'lichess';
  handle: string;
  games_window: number;
  median_rating: number | null;
}

type Tier = 'premium' | 'main' | 'open' | 'unknown';

/** Bin a fingerprinted handle by its median_rating (avg_opponent_rating
 *  proxy) into the Premium / Main / Open targeting layers. Lichess cuts
 *  are higher than chess.com to account for rating inflation. */
function tierFor(platform: 'chess.com' | 'lichess', medianRating: number | null): Tier {
  if (medianRating === null) return 'unknown';
  if (platform === 'chess.com') {
    if (medianRating >= 1800) return 'premium';
    if (medianRating >= 1500) return 'main';
    if (medianRating >= 1000) return 'open';
    return 'unknown';
  }
  // lichess
  if (medianRating >= 2100) return 'premium';
  if (medianRating >= 1800) return 'main';
  if (medianRating >= 1400) return 'open';
  return 'unknown';
}

/** Pick a random subset of fingerprinted handles with enough headroom for
 *  the largest sample size. ORDER BY random() is the simplest sampler;
 *  Postgres's TABLESAMPLE would be faster on huge corpora but isn't needed
 *  for the 14k+31k scale we have today. */
async function selectTargets(
  sql: postgres.Sql,
  platformFilter: CliArgs['platform'],
  maxSampleSize: number,
  limit: number,
): Promise<BenchTarget[]> {
  const minGames = maxSampleSize + MIN_TRAIN_GAMES;
  type Row = {
    handle_id: string;
    platform: 'chess.com' | 'lichess';
    handle: string;
    games_window: number;
    median_rating: number | null;
  };
  const rows =
    platformFilter === 'both'
      ? await sql<Row[]>`
          SELECT handle_id::text, platform, handle, games_window, median_rating
          FROM account_fingerprints
          WHERE games_window >= ${minGames}
          ORDER BY random()
          LIMIT ${limit}
        `
      : await sql<Row[]>`
          SELECT handle_id::text, platform, handle, games_window, median_rating
          FROM account_fingerprints
          WHERE games_window >= ${minGames}
            AND platform = ${platformFilter}
          ORDER BY random()
          LIMIT ${limit}
        `;
  return rows;
}

interface RawGame {
  white_handle_snapshot: string | null;
  black_handle_snapshot: string | null;
  white_rating: number | null;
  black_rating: number | null;
  result: '1-0' | '0-1' | '1/2-1/2';
  time_class: string | null;
  opening_eco: string | null;
  ply_count: number;
  termination: string | null;
  played_at: string;
  pgn: string | null;
}

/** Load all games for a target handle from the games table, in GameRow shape
 *  with move_seq_prefix populated. Mirrors stage3/run.ts loadSelfGames. */
async function loadTargetGames(
  sql: postgres.Sql,
  platform: 'chess.com' | 'lichess',
  handle: string,
): Promise<GameRow[]> {
  const lh = handle.toLowerCase();
  const rows = await sql<RawGame[]>`
    SELECT
      white_handle_snapshot, black_handle_snapshot, white_rating, black_rating,
      result, time_class, opening_eco, ply_count, termination, played_at, pgn
    FROM games
    WHERE source = ${platform}
      AND (LOWER(white_handle_snapshot) = ${lh} OR LOWER(black_handle_snapshot) = ${lh})
  `;
  return rows.map((r) => {
    const isWhite = (r.white_handle_snapshot ?? '').toLowerCase() === lh;
    return {
      color: isWhite ? ('white' as const) : ('black' as const),
      result: r.result,
      time_class: r.time_class,
      opening_eco: r.opening_eco,
      ply_count: r.ply_count,
      termination: r.termination,
      opponent_rating: isWhite ? r.black_rating : r.white_rating,
      played_at: new Date(r.played_at),
      move_seq_prefix: pgnToMoveSeqPrefix(r.pgn),
    };
  });
}

interface TrialResult {
  handle: string;
  platform: 'chess.com' | 'lichess';
  tier: Tier;
  sample_size: number;
  seed: number;
  rank: number | null; // null = not in top-K
  combined_score: number | null;
}

function findRank(
  matches: Stage3Match[],
  targetHandleId: string,
): {
  rank: number | null;
  combined_score: number | null;
} {
  for (let i = 0; i < matches.length; i++) {
    if (matches[i]!.player_id === targetHandleId) {
      return { rank: i + 1, combined_score: matches[i]!.combined_score };
    }
  }
  return { rank: null, combined_score: null };
}

interface Metrics {
  trials: number;
  top1: number;
  top3: number;
  top10: number;
  median_rank: number | null; // null when many "missed" — see comments
  mrr: number;
}

function aggregateMetrics(trials: TrialResult[], topK: number): Metrics {
  const n = trials.length;
  if (n === 0) {
    return { trials: 0, top1: 0, top3: 0, top10: 0, median_rank: null, mrr: 0 };
  }
  let top1 = 0;
  let top3 = 0;
  let top10 = 0;
  let mrrSum = 0;
  const ranks: number[] = [];
  for (const t of trials) {
    if (t.rank !== null) {
      if (t.rank <= 1) top1++;
      if (t.rank <= 3) top3++;
      if (t.rank <= 10) top10++;
      mrrSum += 1 / t.rank;
      ranks.push(t.rank);
    }
    // Misses (target not in top-K): contribute 0 to top-X and 0 to MRR.
    // For median, we treat missed trials as rank=topK+1 so the metric is
    // honest about how far the matcher fell short.
    else {
      ranks.push(topK + 1);
    }
  }
  ranks.sort((a, b) => a - b);
  const mid = Math.floor(ranks.length / 2);
  const median = ranks.length % 2 === 0 ? (ranks[mid - 1]! + ranks[mid]!) / 2 : ranks[mid]!;
  return {
    trials: n,
    top1: top1 / n,
    top3: top3 / n,
    top10: top10 / n,
    median_rank: median,
    mrr: mrrSum / n,
  };
}

interface Guidance {
  quick_scan: number | null;
  recommended: number | null;
  high_confidence: number | null;
  rules: {
    quick_scan: string;
    recommended: string;
    high_confidence: string;
  };
}

function deriveGuidance(perSize: { sample_size: number; metrics: Metrics }[]): Guidance {
  const sorted = [...perSize].sort((a, b) => a.sample_size - b.sample_size);
  const quick = sorted.find((m) => m.metrics.top10 >= 0.5)?.sample_size ?? null;
  const recommended = sorted.find((m) => m.metrics.top3 >= 0.7)?.sample_size ?? null;
  const high = sorted.find((m) => m.metrics.top1 >= 0.75)?.sample_size ?? null;
  return {
    quick_scan: quick,
    recommended,
    high_confidence: high,
    rules: {
      quick_scan: 'smallest sample size with top-10 accuracy >= 50%',
      recommended: 'smallest sample size with top-3 accuracy >= 70%',
      high_confidence: 'smallest sample size with top-1 accuracy >= 75%',
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startTs = new Date();

  console.log(
    `[cascade-bench] platform=${args.platform} limit=${args.limit} ` +
      `sample-sizes=[${args.sampleSizes.join(',')}] seeds=[${args.seeds.join(',')}] ` +
      `top-k=${args.topK}`,
  );

  const { client: sql } = getGamesDb();
  try {
    const maxSampleSize = Math.max(...args.sampleSizes);
    const targets = await selectTargets(sql, args.platform, maxSampleSize, args.limit);
    console.log(
      `[cascade-bench] selected ${fmt(targets.length)} target handles ` +
        `(games_window >= ${maxSampleSize + MIN_TRAIN_GAMES})`,
    );

    // Corpus size for the report — the pool the matcher actually retrieves from.
    const corpus = await sql<{ platform: string; n: string }[]>`
      SELECT platform, COUNT(*)::text AS n FROM account_fingerprints
      WHERE games_window >= 10
      GROUP BY platform ORDER BY platform
    `;
    const corpusSize: Record<string, number> = {};
    for (const c of corpus) corpusSize[c.platform] = Number(c.n);

    const trials: TrialResult[] = [];
    let processed = 0;
    const t0 = Date.now();
    for (const target of targets) {
      const games = await loadTargetGames(sql, target.platform, target.handle);
      if (games.length < maxSampleSize + MIN_TRAIN_GAMES) {
        processed++;
        continue;
      }
      for (const sampleSize of args.sampleSizes) {
        for (const seed of args.seeds) {
          // For each (sample_size, seed), sample seeded games as the query
          // and run cascade. The rank we record is the position of the
          // target's handle in the returned top-K (or null if missed).
          const sample = sampleN(games, sampleSize, seed);
          const features = extractFeaturesV0(sample);
          const matches = await rankFingerprints(sql, features, { topK: args.topK });
          const { rank, combined_score } = findRank(matches, target.handle_id);
          trials.push({
            handle: target.handle,
            platform: target.platform,
            tier: tierFor(target.platform, target.median_rating),
            sample_size: sampleSize,
            seed,
            rank,
            combined_score,
          });
        }
      }
      processed++;
      if (processed % 10 === 0 || processed === targets.length) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        const trialsSoFar = processed * args.sampleSizes.length * args.seeds.length;
        console.log(
          `  [${processed}/${targets.length}] ${target.platform}/${target.handle} ` +
            `(${trialsSoFar} trials, ${elapsed}s)`,
        );
      }
    }

    // ---- Aggregate ------------------------------------------------------
    const perSize = args.sampleSizes
      .map((size) => ({
        sample_size: size,
        metrics: aggregateMetrics(
          trials.filter((t) => t.sample_size === size),
          args.topK,
        ),
      }))
      .sort((a, b) => a.sample_size - b.sample_size);

    const perPlatform: Record<string, { sample_size: number; metrics: Metrics }[]> = {};
    if (args.platform === 'both') {
      for (const plat of ['chess.com', 'lichess']) {
        perPlatform[plat] = args.sampleSizes
          .map((size) => ({
            sample_size: size,
            metrics: aggregateMetrics(
              trials.filter((t) => t.sample_size === size && t.platform === plat),
              args.topK,
            ),
          }))
          .sort((a, b) => a.sample_size - b.sample_size);
      }
    }

    // Per-tier breakdown: tells you whether the Premium pool is identifiable
    // from sparser samples than Open. Tier copy in /scout/match should vary
    // accordingly if these numbers diverge.
    const perTier: Record<Tier, { sample_size: number; metrics: Metrics }[]> = {
      premium: [],
      main: [],
      open: [],
      unknown: [],
    };
    for (const tier of ['premium', 'main', 'open', 'unknown'] as Tier[]) {
      perTier[tier] = args.sampleSizes
        .map((size) => ({
          sample_size: size,
          metrics: aggregateMetrics(
            trials.filter((t) => t.sample_size === size && t.tier === tier),
            args.topK,
          ),
        }))
        .sort((a, b) => a.sample_size - b.sample_size);
    }
    const tierCounts = trials.reduce(
      (acc, t) => {
        acc[t.tier] = (acc[t.tier] ?? 0) + 1;
        return acc;
      },
      {} as Record<Tier, number>,
    );

    const guidance = deriveGuidance(perSize);

    const totalDt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n[cascade-bench] DONE in ${totalDt}s`);
    console.log(`  total trials: ${fmt(trials.length)}`);
    console.log(`\n  metrics by sample_size:`);
    for (const r of perSize) {
      const m = r.metrics;
      console.log(
        `    n=${String(r.sample_size).padStart(3)}: ` +
          `trials=${fmt(m.trials).padStart(5)}  ` +
          `top1=${(m.top1 * 100).toFixed(1).padStart(5)}%  ` +
          `top3=${(m.top3 * 100).toFixed(1).padStart(5)}%  ` +
          `top10=${(m.top10 * 100).toFixed(1).padStart(5)}%  ` +
          `median_rank=${m.median_rank ?? '—'}  ` +
          `MRR=${m.mrr.toFixed(3)}`,
      );
    }
    console.log(`\n  derived guidance:`);
    console.log(`    quick_scan        = ${guidance.quick_scan ?? '(not met)'} games`);
    console.log(`    recommended       = ${guidance.recommended ?? '(not met)'} games`);
    console.log(`    high_confidence   = ${guidance.high_confidence ?? '(not met)'} games`);

    console.log(
      `\n  metrics by tier (Premium 1800+/2100+, Main 1500-1799/1800-2099, Open 1000-1499/1400-1799):`,
    );
    for (const tier of ['premium', 'main', 'open', 'unknown'] as Tier[]) {
      const trialsInTier = tierCounts[tier] ?? 0;
      if (trialsInTier === 0) continue;
      console.log(`    ${tier.padEnd(8)} (${fmt(trialsInTier)} trials)`);
      for (const r of perTier[tier]) {
        const m = r.metrics;
        if (m.trials === 0) continue;
        console.log(
          `      n=${String(r.sample_size).padStart(3)}: ` +
            `top1=${(m.top1 * 100).toFixed(1).padStart(5)}%  ` +
            `top3=${(m.top3 * 100).toFixed(1).padStart(5)}%  ` +
            `top10=${(m.top10 * 100).toFixed(1).padStart(5)}%`,
        );
      }
    }

    // ---- Write JSON artifact -------------------------------------------
    const artifact = {
      version: 'v1',
      ts: startTs.toISOString(),
      finished_at: new Date().toISOString(),
      duration_seconds: Math.round((Date.now() - t0) / 1000),
      config: {
        platform: args.platform,
        limit: args.limit,
        sample_sizes: args.sampleSizes,
        seeds: args.seeds,
        top_k: args.topK,
      },
      corpus_size: corpusSize,
      total_targets: targets.length,
      total_trials: trials.length,
      metrics_by_sample_size: perSize,
      metrics_by_platform: args.platform === 'both' ? perPlatform : undefined,
      metrics_by_tier: perTier,
      tier_counts: tierCounts,
      guidance,
    };
    await mkdir(path.dirname(args.out), { recursive: true });
    await writeFile(args.out, JSON.stringify(artifact, null, 2), 'utf8');
    console.log(`\n[cascade-bench] artifact written to ${args.out}`);

    // Publish to Supabase (separate connection from the games-corpus client
    // above). The /benchmarks page reads the latest snapshot from there.
    await publishBenchmarkArtifact('sparse_cascade', artifact);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('sparse-cascade-benchmark failed:', err);
  process.exit(1);
});
