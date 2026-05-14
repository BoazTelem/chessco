/**
 * Out-of-sample repertoire matcher benchmark.
 *
 * This is the eval for Chessco's PGN-first "same player, different games"
 * promise:
 *
 *   1. Pick scout-ready accounts with enough games.
 *   2. Hold out N games from one account.
 *   3. Rebuild that account's candidate repertoire from the remaining games.
 *   4. Use the held-out games as the query sample.
 *   5. Rank the account against the candidate corpus and record its rank.
 *
 * The held-out games are never present in the target account's candidate
 * vector for that trial. That guardrail is the whole point of this eval.
 *
 * Usage:
 *   pnpm --filter @chessco/workers eval:repertoire
 *   pnpm --filter @chessco/workers eval:repertoire -- --limit 500 --seeds 1,2,3,4,5
 *   pnpm --filter @chessco/workers eval:repertoire -- --platform lichess --out apps/web/public/repertoire-benchmark.json
 */
import 'dotenv/config';
import type postgres from 'postgres';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, getGamesDb } from '../db';

type Platform = 'lichess' | 'chess.com';
type Color = 'white' | 'black';
type Result = 'win' | 'loss' | 'draw';
type SparseVector = Map<string, number>;

const DEFAULT_SAMPLE_SIZES = [1, 2, 3, 4, 5, 8, 10, 15, 20, 30];
const DEFAULT_SEEDS = [1, 2, 3];
const DEFAULT_DEPTH = 12;
const DEFAULT_LIMIT = 250;
const DEFAULT_MIN_TRAIN_GAMES = 10;
const STARTING_FEN_KEY_PARTS = 4;
const HALF_LIFE_YEARS = 1.5;
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;
const LN2 = Math.log(2);

interface CliArgs {
  limit: number;
  platform: Platform | null;
  sampleSizes: number[];
  seeds: number[];
  depth: number;
  minTrainGames: number;
  outPath: string;
  rows: boolean;
}

interface Account {
  id: string;
  platform: Platform;
  handle: string;
  games_seen: number;
}

interface AccountMeta {
  country: string | null;
  title: string | null;
  claimed_name: string | null;
}

interface RawGameRow {
  source: Platform;
  id: string;
  played_at: string;
  result: '1-0' | '0-1' | '1/2-1/2' | '*';
  white_handle: string | null;
  black_handle: string | null;
  white_rating: number | null;
  black_rating: number | null;
  time_class: string | null;
  opening_eco: string | null;
}

interface MoveRow {
  game_id: string;
  ply: number;
  uci: string;
  fen_before: string;
}

interface GameRecord {
  id: string;
  playedAt: Date;
  playerColor: Color;
  result: Result;
  opponentRating: number | null;
  timeClass: string | null;
  openingEco: string | null;
  movesUci: string[];
  fensBefore: string[];
}

interface AccountStats {
  games: number;
  avgOpponentRating: number | null;
  ratingBand: string;
  accountGameCountBand: string;
  openingDiversityBand: string;
  distinctEcoCount: number;
}

interface SampleQuality {
  games: number;
  whiteGames: number;
  blackGames: number;
  colorBalance: 'white_only' | 'black_only' | 'balanced' | 'skewed';
  distinctEcoCount: number;
  ecoCoverage: number;
  avgOpponentRating: number | null;
  dominantTimeClass: string | null;
  vectorKeys: number;
  openingUniqueness: 'rare' | 'mixed' | 'common' | 'unknown';
  avgCandidateKeyCoverage: number | null;
}

interface BenchmarkRow {
  sample_size: number;
  seed: number;
  target: {
    player_id: string;
    platform: Platform;
    handle: string;
  };
  rank: number;
  top_handle: string;
  top_platform: Platform;
  top_score: number;
  target_score: number;
  second_score: number | null;
  score_margin: number | null;
  sample_quality: SampleQuality;
  segments: {
    platform: Platform;
    rating_band: string;
    title_status: 'titled' | 'amateur_or_unknown' | 'metadata_missing';
    context_available: 'yes' | 'no';
    account_game_count: string;
    opening_diversity: string;
    sample_color_balance: SampleQuality['colorBalance'];
    sample_opening_uniqueness: SampleQuality['openingUniqueness'];
    dominant_time_class: string;
  };
}

interface Metrics {
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
  calibration_bins: CalibrationBin[];
}

interface CalibrationBin {
  min_score: number;
  max_score: number;
  n: number;
  top1_accuracy: number;
  false_positive_rate: number;
}

interface Guidance {
  quick_scan_games: number | null;
  recommended_games: number | null;
  high_confidence_games: number | null;
  thresholds: {
    quick_scan: string;
    recommended: string;
    high_confidence: string;
  };
}

function parseCsvInts(raw: string, label: string): number[] {
  const nums = raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (nums.length === 0) throw new Error(`${label} must contain at least one positive integer`);
  return [...new Set(nums)].sort((a, b) => a - b);
}

function parseArgs(argv: string[]): CliArgs {
  const here = dirname(fileURLToPath(import.meta.url));
  const defaultOut = pathResolve(here, '../../../web/public/repertoire-benchmark.json');
  const args: CliArgs = {
    limit: DEFAULT_LIMIT,
    platform: null,
    sampleSizes: DEFAULT_SAMPLE_SIZES,
    seeds: DEFAULT_SEEDS,
    depth: DEFAULT_DEPTH,
    minTrainGames: DEFAULT_MIN_TRAIN_GAMES,
    outPath: defaultOut,
    rows: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit' && argv[i + 1]) args.limit = Number.parseInt(argv[++i]!, 10);
    else if (a === '--platform' && argv[i + 1]) {
      const p = argv[++i]!;
      if (p !== 'lichess' && p !== 'chess.com') throw new Error(`bad --platform ${p}`);
      args.platform = p;
    } else if (a === '--sample-sizes' && argv[i + 1]) {
      args.sampleSizes = parseCsvInts(argv[++i]!, '--sample-sizes');
    } else if (a === '--seeds' && argv[i + 1]) {
      args.seeds = parseCsvInts(argv[++i]!, '--seeds');
    } else if (a === '--depth' && argv[i + 1]) {
      args.depth = Number.parseInt(argv[++i]!, 10);
    } else if (a === '--min-train-games' && argv[i + 1]) {
      args.minTrainGames = Number.parseInt(argv[++i]!, 10);
    } else if (a === '--out' && argv[i + 1]) {
      args.outPath = pathResolve(process.cwd(), argv[++i]!);
    } else if (a === '--no-rows') {
      args.rows = false;
    } else {
      throw new Error(`unrecognized arg: ${a}`);
    }
  }
  if (args.limit < 2) throw new Error('--limit must be at least 2');
  if (args.depth < 1 || args.depth > 60) throw new Error('--depth must be 1..60');
  if (args.minTrainGames < 1) throw new Error('--min-train-games must be positive');
  return args;
}

function accountKey(platform: string, handle: string): string {
  return `${platform}::${handle.toLowerCase()}`;
}

function fenKey(fen: string): string {
  return fen.split(' ').slice(0, STARTING_FEN_KEY_PARTS).join(' ');
}

function recencyWeight(playedAt: Date, now: Date): number {
  const ageYears = Math.max(0, (now.getTime() - playedAt.getTime()) / MS_PER_YEAR);
  return Math.exp(-LN2 * (ageYears / HALF_LIFE_YEARS));
}

function stableHash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleWithoutReplacement<T>(arr: T[], n: number, seed: number): T[] {
  if (n >= arr.length) return arr.slice();
  const rng = makeRng(seed);
  const idx = arr.map((_, i) => i);
  for (let i = idx.length - 1; i > idx.length - 1 - n; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return idx.slice(idx.length - n).map((i) => arr[i]!);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function listAccounts(sql: postgres.Sql, args: CliArgs): Promise<Account[]> {
  const maxSample = Math.max(...args.sampleSizes);
  const minGames = maxSample + args.minTrainGames;
  if (args.platform) {
    return sql<Account[]>`
      SELECT id::text, platform, handle, games_seen
      FROM handles
      WHERE scout_ready_at IS NOT NULL
        AND platform = ${args.platform}
        AND games_seen >= ${minGames}
      ORDER BY games_seen DESC
      LIMIT ${args.limit}
    `;
  }
  return sql<Account[]>`
    SELECT id::text, platform, handle, games_seen
    FROM handles
    WHERE scout_ready_at IS NOT NULL
      AND platform IN ('lichess', 'chess.com')
      AND games_seen >= ${minGames}
    ORDER BY games_seen DESC
    LIMIT ${args.limit}
  `;
}

async function loadMetadata(accounts: Account[]): Promise<Map<string, AccountMeta>> {
  const meta = new Map<string, AccountMeta>();
  try {
    const { client } = getDb();
    try {
      for (const platform of ['lichess', 'chess.com'] as const) {
        const handles = accounts
          .filter((a) => a.platform === platform)
          .map((a) => a.handle.toLowerCase());
        if (handles.length === 0) continue;
        const rows = await client<
          {
            platform: Platform;
            handle: string;
            country: string | null;
            title: string | null;
            claimed_name: string | null;
          }[]
        >`
          SELECT platform, handle, country, title, claimed_name
          FROM platform_players
          WHERE platform = ${platform}
            AND LOWER(handle) = ANY(${handles}::text[])
        `;
        for (const r of rows) {
          meta.set(accountKey(r.platform, r.handle), {
            country: r.country,
            title: r.title,
            claimed_name: r.claimed_name,
          });
        }
      }
    } finally {
      await client.end({ timeout: 5 });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[benchmark] Supabase metadata unavailable; continuing without title/country segments: ${msg}`,
    );
  }
  return meta;
}

async function loadRecordsForAccounts(
  sql: postgres.Sql,
  accounts: Account[],
  depth: number,
): Promise<{
  recordsByAccount: Map<string, GameRecord[]>;
  rawGamesLoaded: number;
  movesLoaded: number;
}> {
  const accountByPlatformHandle = new Map<string, Account>();
  const handlesByPlatform = new Map<Platform, string[]>();
  for (const a of accounts) {
    accountByPlatformHandle.set(accountKey(a.platform, a.handle), a);
    const arr = handlesByPlatform.get(a.platform) ?? [];
    arr.push(a.handle.toLowerCase());
    handlesByPlatform.set(a.platform, arr);
  }

  const games: RawGameRow[] = [];
  for (const [platform, handles] of handlesByPlatform) {
    const rows = await sql<RawGameRow[]>`
      SELECT source, id::text, played_at::text, result,
             white_handle_snapshot AS white_handle,
             black_handle_snapshot AS black_handle,
             white_rating, black_rating, time_class, opening_eco
      FROM games
      WHERE source = ${platform}
        AND played_at > NOW() - INTERVAL '12 months'
        AND (
          LOWER(white_handle_snapshot) = ANY(${handles}::text[])
          OR LOWER(black_handle_snapshot) = ANY(${handles}::text[])
        )
    `;
    games.push(...rows);
  }

  const gameIds = [...new Set(games.map((g) => g.id))];
  const movesByGame = new Map<string, MoveRow[]>();
  let movesLoaded = 0;
  for (const ids of chunk(gameIds, 5000)) {
    const rows = await sql<MoveRow[]>`
      SELECT m.game_id::text, m.ply, m.uci, p.fen AS fen_before
      FROM moves m
      INNER JOIN positions p ON p.id = m.fen_before_id
      WHERE m.game_id = ANY(${ids}::uuid[])
        AND m.ply <= ${depth * 2}
      ORDER BY m.game_id, m.ply
    `;
    movesLoaded += rows.length;
    for (const m of rows) {
      const arr = movesByGame.get(m.game_id) ?? [];
      arr.push(m);
      movesByGame.set(m.game_id, arr);
    }
  }

  const recordsByAccount = new Map<string, GameRecord[]>();
  function addRecord(key: string, g: RawGameRow, playerColor: Color, moves: MoveRow[]): void {
    let result: Result;
    if (g.result === '1/2-1/2') result = 'draw';
    else if (g.result === '1-0') result = playerColor === 'white' ? 'win' : 'loss';
    else if (g.result === '0-1') result = playerColor === 'black' ? 'win' : 'loss';
    else return;

    const arr = recordsByAccount.get(key) ?? [];
    arr.push({
      id: g.id,
      playedAt: new Date(g.played_at),
      playerColor,
      result,
      opponentRating: playerColor === 'white' ? g.black_rating : g.white_rating,
      timeClass: g.time_class,
      openingEco: g.opening_eco,
      movesUci: moves.map((m) => m.uci),
      fensBefore: moves.map((m) => fenKey(m.fen_before)),
    });
    recordsByAccount.set(key, arr);
  }

  for (const g of games) {
    const moves = movesByGame.get(g.id);
    if (!moves || moves.length === 0) continue;
    const white = g.white_handle?.toLowerCase();
    const black = g.black_handle?.toLowerCase();
    if (white) {
      const key = accountKey(g.source, white);
      if (accountByPlatformHandle.has(key)) addRecord(key, g, 'white', moves);
    }
    if (black) {
      const key = accountKey(g.source, black);
      if (accountByPlatformHandle.has(key)) addRecord(key, g, 'black', moves);
    }
  }

  for (const records of recordsByAccount.values()) {
    records.sort((a, b) => b.playedAt.getTime() - a.playedAt.getTime());
  }

  return { recordsByAccount, rawGamesLoaded: games.length, movesLoaded };
}

function buildRepertoireVector(records: GameRecord[], now: Date, depth: number): SparseVector {
  const v: SparseVector = new Map();
  for (const g of records) {
    const weight = recencyWeight(g.playedAt, now);
    const limit = Math.min(g.movesUci.length, depth * 2);
    for (let i = 0; i < limit; i++) {
      const isPlayerMove = g.playerColor === 'white' ? i % 2 === 0 : i % 2 === 1;
      if (!isPlayerMove) continue;
      const fen = g.fensBefore[i];
      const uci = g.movesUci[i];
      if (!fen || !uci) break;
      const key = `${g.playerColor}|${fen}|${uci}`;
      v.set(key, (v.get(key) ?? 0) + weight);
    }
  }
  return v;
}

function cosine(a: SparseVector, b: SparseVector): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const av of a.values()) magA += av * av;
  for (const bv of b.values()) magB += bv * bv;
  if (magA === 0 || magB === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [k, sv] of small) {
    const lv = large.get(k);
    if (lv !== undefined) dot += sv * lv;
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function ratingBand(rating: number | null): string {
  if (rating === null) return 'unknown';
  if (rating < 1500) return '<1500';
  if (rating < 1800) return '1500-1799';
  if (rating < 2100) return '1800-2099';
  return '2100+';
}

function gameCountBand(n: number): string {
  if (n < 50) return '10-49';
  if (n < 200) return '50-199';
  if (n < 1000) return '200-999';
  return '1000+';
}

function accountStats(records: GameRecord[]): AccountStats {
  let oppSum = 0;
  let oppCount = 0;
  const ecos = new Set<string>();
  for (const g of records) {
    if (g.opponentRating !== null) {
      oppSum += g.opponentRating;
      oppCount++;
    }
    if (g.openingEco) ecos.add(g.openingEco);
  }
  const avg = oppCount > 0 ? oppSum / oppCount : null;
  const ecoRatio = records.length > 0 ? ecos.size / records.length : 0;
  const openingDiversityBand = ecoRatio < 0.05 ? 'narrow' : ecoRatio < 0.15 ? 'mixed' : 'wide';
  return {
    games: records.length,
    avgOpponentRating: avg,
    ratingBand: ratingBand(avg),
    accountGameCountBand: gameCountBand(records.length),
    openingDiversityBand,
    distinctEcoCount: ecos.size,
  };
}

function dominantTimeClass(records: GameRecord[]): string | null {
  const counts = new Map<string, number>();
  for (const g of records) {
    if (!g.timeClass) continue;
    counts.set(g.timeClass, (counts.get(g.timeClass) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [tc, count] of counts) {
    if (count > bestCount) {
      best = tc;
      bestCount = count;
    }
  }
  return best;
}

function colorBalance(white: number, black: number): SampleQuality['colorBalance'] {
  if (white > 0 && black === 0) return 'white_only';
  if (black > 0 && white === 0) return 'black_only';
  const total = white + black;
  const minShare = total > 0 ? Math.min(white, black) / total : 0;
  return minShare >= 0.35 ? 'balanced' : 'skewed';
}

function sampleQuality(
  sample: GameRecord[],
  queryVector: SparseVector,
  keyDf: Map<string, number>,
  candidateCount: number,
): SampleQuality {
  const white = sample.filter((g) => g.playerColor === 'white').length;
  const black = sample.length - white;
  const ecos = new Set(sample.map((g) => g.openingEco).filter((e): e is string => Boolean(e)));
  const opp = sample.map((g) => g.opponentRating).filter((r): r is number => r !== null);
  const avgOpponentRating = opp.length > 0 ? opp.reduce((sum, r) => sum + r, 0) / opp.length : null;
  let coverageSum = 0;
  let coverageCount = 0;
  for (const k of queryVector.keys()) {
    const df = keyDf.get(k);
    if (df === undefined) continue;
    coverageSum += df / candidateCount;
    coverageCount++;
  }
  const avgCoverage = coverageCount > 0 ? coverageSum / coverageCount : null;
  const openingUniqueness =
    avgCoverage === null
      ? 'unknown'
      : avgCoverage <= 0.05
        ? 'rare'
        : avgCoverage >= 0.2
          ? 'common'
          : 'mixed';
  return {
    games: sample.length,
    whiteGames: white,
    blackGames: black,
    colorBalance: colorBalance(white, black),
    distinctEcoCount: ecos.size,
    ecoCoverage: sample.length > 0 ? ecos.size / sample.length : 0,
    avgOpponentRating,
    dominantTimeClass: dominantTimeClass(sample),
    vectorKeys: queryVector.size,
    openingUniqueness,
    avgCandidateKeyCoverage: avgCoverage,
  };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx]!;
}

function aggregate(rows: BenchmarkRow[]): Metrics {
  const n = rows.length;
  if (n === 0) {
    return {
      n: 0,
      top1: 0,
      top3: 0,
      top5: 0,
      top10: 0,
      mrr: 0,
      median_rank: null,
      mean_rank: null,
      mean_top_score: null,
      mean_target_score: null,
      false_positive_rate_top1: 0,
      calibration_bins: [],
    };
  }
  const ranks = rows.map((r) => r.rank).sort((a, b) => a - b);
  const topScores = rows.map((r) => r.top_score);
  const targetScores = rows.map((r) => r.target_score);
  const sum = (xs: number[]) => xs.reduce((acc, x) => acc + x, 0);
  const top1 = rows.filter((r) => r.rank === 1).length / n;
  return {
    n,
    top1,
    top3: rows.filter((r) => r.rank <= 3).length / n,
    top5: rows.filter((r) => r.rank <= 5).length / n,
    top10: rows.filter((r) => r.rank <= 10).length / n,
    mrr: sum(rows.map((r) => 1 / r.rank)) / n,
    median_rank: percentile(ranks, 0.5),
    mean_rank: sum(rows.map((r) => r.rank)) / n,
    mean_top_score: sum(topScores) / n,
    mean_target_score: sum(targetScores) / n,
    false_positive_rate_top1: 1 - top1,
    calibration_bins: calibration(rows),
  };
}

function calibration(rows: BenchmarkRow[]): CalibrationBin[] {
  const bins = [
    [0, 0.1],
    [0.1, 0.2],
    [0.2, 0.3],
    [0.3, 0.4],
    [0.4, 0.5],
    [0.5, 0.6],
    [0.6, 0.7],
    [0.7, 0.8],
    [0.8, 0.9],
    [0.9, 1.01],
  ];
  const out: CalibrationBin[] = [];
  for (const [min, max] of bins) {
    const subset = rows.filter((r) => r.top_score >= min! && r.top_score < max!);
    if (subset.length === 0) continue;
    const top1 = subset.filter((r) => r.rank === 1).length / subset.length;
    out.push({
      min_score: min!,
      max_score: max! >= 1 ? 1 : max!,
      n: subset.length,
      top1_accuracy: top1,
      false_positive_rate: 1 - top1,
    });
  }
  return out;
}

function metricsBySampleSize(
  rows: BenchmarkRow[],
): Array<{ sample_size: number; metrics: Metrics }> {
  const sizes = [...new Set(rows.map((r) => r.sample_size))].sort((a, b) => a - b);
  return sizes.map((sampleSize) => ({
    sample_size: sampleSize,
    metrics: aggregate(rows.filter((r) => r.sample_size === sampleSize)),
  }));
}

function segmentMetrics(
  rows: BenchmarkRow[],
  key: keyof BenchmarkRow['segments'],
): Record<string, Array<{ sample_size: number; metrics: Metrics }>> {
  const values = [...new Set(rows.map((r) => r.segments[key]))].sort();
  const out: Record<string, Array<{ sample_size: number; metrics: Metrics }>> = {};
  for (const value of values) {
    out[String(value)] = metricsBySampleSize(rows.filter((r) => r.segments[key] === value));
  }
  return out;
}

function deriveGuidance(bySize: Array<{ sample_size: number; metrics: Metrics }>): Guidance {
  const quick = bySize.find((m) => m.metrics.top10 >= 0.5)?.sample_size ?? null;
  const recommended = bySize.find((m) => m.metrics.top3 >= 0.7)?.sample_size ?? null;
  const high = bySize.find((m) => m.metrics.top1 >= 0.75)?.sample_size ?? null;
  return {
    quick_scan_games: quick,
    recommended_games: recommended,
    high_confidence_games: high,
    thresholds: {
      quick_scan: 'smallest sample size with top-10 accuracy >= 50%',
      recommended: 'smallest sample size with top-3 accuracy >= 70%',
      high_confidence: 'smallest sample size with top-1 accuracy >= 75%',
    },
  };
}

function buildKeyDf(vectors: Map<string, SparseVector>): Map<string, number> {
  const df = new Map<string, number>();
  for (const v of vectors.values()) {
    for (const k of v.keys()) df.set(k, (df.get(k) ?? 0) + 1);
  }
  return df;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[benchmark] limit=${args.limit} platform=${args.platform ?? 'all'} depth=${args.depth} ` +
      `sampleSizes=${args.sampleSizes.join(',')} seeds=${args.seeds.join(',')}`,
  );

  const { client } = getGamesDb();
  try {
    const accounts = await listAccounts(client, args);
    if (accounts.length < 2) throw new Error('not enough scout-ready accounts to benchmark');
    console.log(`[benchmark] selected ${accounts.length} scout-ready accounts`);

    const meta = await loadMetadata(accounts);
    const loaded = await loadRecordsForAccounts(client, accounts, args.depth);
    const now = new Date();

    const eligible = accounts.filter((a) => {
      const records = loaded.recordsByAccount.get(accountKey(a.platform, a.handle)) ?? [];
      return records.length >= Math.max(...args.sampleSizes) + args.minTrainGames;
    });
    if (eligible.length < 2) throw new Error('not enough accounts with loaded move records');
    console.log(
      `[benchmark] ${eligible.length} accounts have enough loaded records; ` +
        `${loaded.rawGamesLoaded} game rows, ${loaded.movesLoaded} moves`,
    );

    const fullVectors = new Map<string, SparseVector>();
    const statsByAccount = new Map<string, AccountStats>();
    for (const a of eligible) {
      const key = accountKey(a.platform, a.handle);
      const records = loaded.recordsByAccount.get(key) ?? [];
      fullVectors.set(key, buildRepertoireVector(records, now, args.depth));
      statsByAccount.set(key, accountStats(records));
    }
    const keyDf = buildKeyDf(fullVectors);

    const rows: BenchmarkRow[] = [];
    let trialCount = 0;
    for (const sampleSize of args.sampleSizes) {
      for (const seed of args.seeds) {
        for (const target of eligible) {
          const targetKey = accountKey(target.platform, target.handle);
          const records = loaded.recordsByAccount.get(targetKey) ?? [];
          if (records.length < sampleSize + args.minTrainGames) continue;

          const sampleSeed = seed + stableHash(`${targetKey}:${sampleSize}`);
          const heldOut = sampleWithoutReplacement(records, sampleSize, sampleSeed);
          const heldOutIds = new Set(heldOut.map((g) => g.id));
          const train = records.filter((g) => !heldOutIds.has(g.id));
          if (train.length < args.minTrainGames) continue;

          const queryVector = buildRepertoireVector(heldOut, now, args.depth);
          const targetTrainVector = buildRepertoireVector(train, now, args.depth);
          if (queryVector.size === 0 || targetTrainVector.size === 0) continue;

          const scores: Array<{ key: string; account: Account; score: number }> = [];
          for (const candidate of eligible) {
            const candidateKey = accountKey(candidate.platform, candidate.handle);
            const vector =
              candidateKey === targetKey ? targetTrainVector : fullVectors.get(candidateKey);
            if (!vector || vector.size === 0) continue;
            scores.push({
              key: candidateKey,
              account: candidate,
              score: cosine(queryVector, vector),
            });
          }
          scores.sort((a, b) => b.score - a.score);
          const rank = scores.findIndex((s) => s.key === targetKey) + 1;
          if (rank <= 0) continue;

          const top = scores[0]!;
          const second = scores[1] ?? null;
          const targetScore = scores.find((s) => s.key === targetKey)!.score;
          const quality = sampleQuality(heldOut, queryVector, keyDf, eligible.length);
          const targetStats = statsByAccount.get(targetKey)!;
          const targetMeta = meta.get(targetKey);

          rows.push({
            sample_size: sampleSize,
            seed,
            target: {
              player_id: target.id,
              platform: target.platform,
              handle: target.handle,
            },
            rank,
            top_handle: top.account.handle,
            top_platform: top.account.platform,
            top_score: top.score,
            target_score: targetScore,
            second_score: second?.score ?? null,
            score_margin: second ? top.score - second.score : null,
            sample_quality: quality,
            segments: {
              platform: target.platform,
              rating_band: targetStats.ratingBand,
              title_status: targetMeta
                ? targetMeta.title
                  ? 'titled'
                  : 'amateur_or_unknown'
                : 'metadata_missing',
              context_available:
                targetMeta && (targetMeta.country || targetMeta.claimed_name || targetMeta.title)
                  ? 'yes'
                  : 'no',
              account_game_count: targetStats.accountGameCountBand,
              opening_diversity: targetStats.openingDiversityBand,
              sample_color_balance: quality.colorBalance,
              sample_opening_uniqueness: quality.openingUniqueness,
              dominant_time_class: quality.dominantTimeClass ?? 'unknown',
            },
          });
          trialCount++;
        }
      }
      console.log(`[benchmark] sample_size=${sampleSize}: ${trialCount} cumulative trials`);
    }

    const bySampleSize = metricsBySampleSize(rows);
    const output = {
      run_at: new Date().toISOString(),
      methodology:
        'out-of-sample repertoire overlap: held-out query games are excluded from the target candidate vector before ranking',
      config: {
        account_limit: args.limit,
        platform: args.platform,
        sample_sizes: args.sampleSizes,
        seeds: args.seeds,
        depth: args.depth,
        min_train_games: args.minTrainGames,
      },
      corpus: {
        selected_accounts: accounts.length,
        eligible_accounts: eligible.length,
        raw_game_rows_loaded: loaded.rawGamesLoaded,
        moves_loaded: loaded.movesLoaded,
        vector_keys: keyDf.size,
        metadata_accounts: meta.size,
      },
      guidance: deriveGuidance(bySampleSize),
      metrics_by_sample_size: bySampleSize,
      segments: {
        platform: segmentMetrics(rows, 'platform'),
        rating_band: segmentMetrics(rows, 'rating_band'),
        title_status: segmentMetrics(rows, 'title_status'),
        context_available: segmentMetrics(rows, 'context_available'),
        account_game_count: segmentMetrics(rows, 'account_game_count'),
        opening_diversity: segmentMetrics(rows, 'opening_diversity'),
        sample_color_balance: segmentMetrics(rows, 'sample_color_balance'),
        sample_opening_uniqueness: segmentMetrics(rows, 'sample_opening_uniqueness'),
        dominant_time_class: segmentMetrics(rows, 'dominant_time_class'),
      },
      rows: args.rows ? rows : undefined,
    };

    mkdirSync(dirname(args.outPath), { recursive: true });
    writeFileSync(args.outPath, JSON.stringify(output, null, 2));
    console.log(`[benchmark] wrote ${args.outPath}`);
    for (const m of bySampleSize) {
      console.log(
        `  k=${String(m.sample_size).padStart(2)} n=${m.metrics.n} ` +
          `top1=${(m.metrics.top1 * 100).toFixed(1)}% ` +
          `top3=${(m.metrics.top3 * 100).toFixed(1)}% ` +
          `top10=${(m.metrics.top10 * 100).toFixed(1)}% ` +
          `medianRank=${m.metrics.median_rank ?? 'n/a'}`,
      );
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('[benchmark] failed:', err);
  process.exit(1);
});
