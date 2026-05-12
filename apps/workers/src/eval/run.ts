/**
 * Leave-K-out identification eval.
 *
 * For every indexed handle with enough games:
 *   - Hold out K games as the "test sample" (what the user would paste)
 *   - Build features from the remaining games (the corpus row)
 *   - Run the V0 Stage 3 matcher with test-features as query against the
 *     corpus of train-only features
 *   - Record the rank at which the handle's own train row appears
 *
 * Outputs:
 *   - Per-handle results to stderr (one line each)
 *   - JSON summary to apps/web/public/trust-eval.json
 *
 * Methodology notes baked into the JSON so /trust can render them honestly:
 *   - V0 features only (ECO repertoire + time class + opp rating). No
 *     Stockfish-derived cp-loss yet — those come after Cloud Run.
 *   - Train-only features per handle: there is NO test leakage in the
 *     candidate-corpus row for the handle being evaluated. Other handles
 *     use full features (which is fine — they're never the held-out test).
 *
 *   pnpm --filter @chessco/workers exec tsx src/eval/run.ts
 *   pnpm --filter @chessco/workers exec tsx src/eval/run.ts --k 5 --min-games 15
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFeaturesV0, type GameRow } from '../features/extract';
import { compareFingerprints } from '../stage3/match';
import { getGamesDb } from '../db';

interface CliArgs {
  k: number;
  minGames: number;
  seed: number;
}

function parseArgs(argv: string[]): CliArgs {
  let k = 5;
  let minGames = 15;
  let seed = 42;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--k' && argv[i + 1]) k = parseInt(argv[++i]!, 10);
    else if (a === '--min-games' && argv[i + 1]) minGames = parseInt(argv[++i]!, 10);
    else if (a === '--seed' && argv[i + 1]) seed = parseInt(argv[++i]!, 10);
    else throw new Error(`unknown arg: ${a}`);
  }
  return { k, minGames, seed };
}

/** Deterministic shuffle (mulberry32) so re-runs are reproducible. */
function shuffleInPlace<T>(xs: T[], seed: number): void {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
}

interface RawGameRow {
  source: 'lichess' | 'chess.com';
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
}

function groupKey(source: string, handle: string): string {
  return `${source}::${handle}`;
}

function ratingBand(rating: number | null): string {
  if (rating === null) return 'unknown';
  if (rating < 1500) return '<1500';
  if (rating < 1800) return '1500-1799';
  if (rating < 2100) return '1800-2099';
  return '2100+';
}

interface BandStats {
  band: string;
  n: number;
  top1: number;
  top5: number;
  top10: number;
  mrr: number;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[eval] k=${args.k} min-games=${args.minGames} seed=${args.seed}`);

  const { client } = getGamesDb();
  try {
    const t0 = Date.now();
    const rows = await client<RawGameRow[]>`
      SELECT source, white_handle_snapshot, black_handle_snapshot,
             white_rating, black_rating,
             result, time_class, opening_eco, ply_count, termination, played_at
      FROM games
      WHERE source IN ('lichess', 'chess.com')
    `;
    console.log(
      `[eval] loaded ${rows.length.toLocaleString()} games in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );

    // Group games by (source, handle).
    const byHandle = new Map<string, GameRow[]>();
    for (const r of rows) {
      const playedAt = new Date(r.played_at);
      if (r.white_handle_snapshot) {
        const k = groupKey(r.source, r.white_handle_snapshot.toLowerCase());
        const list = byHandle.get(k) ?? [];
        list.push({
          color: 'white',
          result: r.result,
          time_class: r.time_class,
          opening_eco: r.opening_eco,
          ply_count: r.ply_count,
          termination: r.termination,
          opponent_rating: r.black_rating,
          played_at: playedAt,
        });
        byHandle.set(k, list);
      }
      if (r.black_handle_snapshot) {
        const k = groupKey(r.source, r.black_handle_snapshot.toLowerCase());
        const list = byHandle.get(k) ?? [];
        list.push({
          color: 'black',
          result: r.result,
          time_class: r.time_class,
          opening_eco: r.opening_eco,
          ply_count: r.ply_count,
          termination: r.termination,
          opponent_rating: r.white_rating,
          played_at: playedAt,
        });
        byHandle.set(k, list);
      }
    }
    console.log(`[eval] grouped into ${byHandle.size.toLocaleString()} handles`);

    // Split TRAIN/TEST per handle. Drop handles with too few games.
    interface Split {
      key: string;
      handle: string;
      source: string;
      trainFeatures: ReturnType<typeof extractFeaturesV0>;
      testFeatures: ReturnType<typeof extractFeaturesV0>;
      avgOpp: number | null;
    }
    const splits: Split[] = [];
    for (const [key, games] of byHandle) {
      if (games.length < args.minGames) continue;
      const sorted = [...games];
      shuffleInPlace(sorted, args.seed + key.length);
      const test = sorted.slice(0, args.k);
      const train = sorted.slice(args.k);
      if (train.length < args.minGames - args.k) continue;
      const trainFeatures = extractFeaturesV0(train);
      const testFeatures = extractFeaturesV0(test);
      const [source, handle] = key.split('::', 2);
      splits.push({
        key,
        handle: handle!,
        source: source!,
        trainFeatures,
        testFeatures,
        avgOpp: trainFeatures.avg_opponent_rating,
      });
    }
    console.log(
      `[eval] ${splits.length.toLocaleString()} handles qualify (>=${args.minGames} games each)`,
    );
    if (splits.length === 0) {
      console.log('[eval] nothing to evaluate.');
      return;
    }

    // For each handle's TEST features, rank against everyone's TRAIN features.
    const ranks: Array<{ band: string; rank: number; handle: string }> = [];
    let processed = 0;
    const evalStart = Date.now();
    for (const target of splits) {
      const scores: Array<{ key: string; score: number }> = [];
      for (const cand of splits) {
        const { combined } = compareFingerprints(target.testFeatures, cand.trainFeatures);
        scores.push({ key: cand.key, score: combined });
      }
      scores.sort((a, b) => b.score - a.score);
      const rank = scores.findIndex((s) => s.key === target.key) + 1;
      ranks.push({ band: ratingBand(target.avgOpp), rank, handle: target.handle });
      processed++;
      if (processed % 200 === 0) {
        console.log(`[eval] progress ${processed}/${splits.length}`);
      }
    }
    console.log(
      `[eval] scored ${splits.length.toLocaleString()} queries in ${((Date.now() - evalStart) / 1000).toFixed(1)}s`,
    );

    // Aggregate overall + per band.
    function aggregate(rs: typeof ranks): {
      top1: number;
      top5: number;
      top10: number;
      mrr: number;
    } {
      const n = rs.length;
      if (n === 0) return { top1: 0, top5: 0, top10: 0, mrr: 0 };
      let t1 = 0;
      let t5 = 0;
      let t10 = 0;
      let mrrSum = 0;
      for (const r of rs) {
        if (r.rank === 1) t1++;
        if (r.rank <= 5) t5++;
        if (r.rank <= 10) t10++;
        mrrSum += 1 / r.rank;
      }
      return { top1: t1 / n, top5: t5 / n, top10: t10 / n, mrr: mrrSum / n };
    }

    const overall = aggregate(ranks);
    const bands: BandStats[] = [];
    for (const band of ['<1500', '1500-1799', '1800-2099', '2100+', 'unknown']) {
      const subset = ranks.filter((r) => r.band === band);
      if (subset.length === 0) continue;
      const agg = aggregate(subset);
      bands.push({ band, n: subset.length, ...agg });
    }

    const summary = {
      run_at: new Date().toISOString(),
      methodology: 'leave-K-out cosine over V0 fingerprint',
      features_version: 'v0',
      features_used: ['eco_white', 'eco_black', 'time_class', 'avg_opponent_rating'],
      k_test_games: args.k,
      min_handle_games: args.minGames,
      total_handles_qualified: splits.length,
      overall,
      by_band: bands,
    };

    console.log('\n========= summary =========');
    console.log(
      `handles evaluated: ${summary.total_handles_qualified}  (k=${args.k} test games each)`,
    );
    console.log(
      `overall:  top1=${(overall.top1 * 100).toFixed(1)}%  top5=${(overall.top5 * 100).toFixed(1)}%  top10=${(overall.top10 * 100).toFixed(1)}%  MRR=${overall.mrr.toFixed(3)}`,
    );
    for (const b of bands) {
      console.log(
        `  ${b.band.padEnd(10)} (n=${b.n.toString().padStart(4)}): top1=${(b.top1 * 100).toFixed(1).padStart(5)}%  top5=${(b.top5 * 100).toFixed(1).padStart(5)}%  top10=${(b.top10 * 100).toFixed(1).padStart(5)}%  MRR=${b.mrr.toFixed(3)}`,
      );
    }

    const here = dirname(fileURLToPath(import.meta.url));
    const outPath = pathResolve(here, '../../../web/public/trust-eval.json');
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(summary, null, 2));
    console.log(`\n[eval] wrote ${outPath}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('[eval] failed:', err);
  process.exit(1);
});
