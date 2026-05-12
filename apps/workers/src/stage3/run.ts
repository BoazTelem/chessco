/**
 * Stage 3 V0 CLI. Two modes:
 *
 *   pnpm --filter @chessco/workers stage3 --self lichess karen_armenia
 *     Take that handle's own games as the target. Used as a smoke test —
 *     the same handle should rank #1 with score ~1.0.
 *
 *   pnpm --filter @chessco/workers stage3 --pgn path/to/games.pgn
 *     Parse the PGN file, treat the games as if from an unknown player,
 *     compute the fingerprint, and rank the cached corpus against it.
 *     This is the "by sample game" demo flow.
 *
 * Either way: prints top 10 candidates with their component scores so
 * you can see WHY each match scored where it did.
 */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { getGamesDb } from '../db';
import { extractFeaturesV0, type GameRow } from '../features/extract';
import { streamGames } from '../lichess-dumps/pgn-stream';
import { processGame } from '../lichess-dumps/parse-game';
import { rankFingerprints } from './match';

interface CliArgs {
  mode: 'self' | 'self-sample' | 'pgn';
  platform?: string;
  handle?: string;
  pgnPath?: string;
  /** For --self-sample: how many games to randomly pick from the handle's set. */
  sampleN?: number;
  /** Seed the sampler so the test is reproducible. */
  seed?: number;
}

function parseArgs(argv: string[]): CliArgs {
  if (argv[0] === '--self' && argv[1] && argv[2]) {
    return { mode: 'self', platform: argv[1], handle: argv[2].toLowerCase() };
  }
  if (argv[0] === '--self-sample' && argv[1] && argv[2] && argv[3]) {
    return {
      mode: 'self-sample',
      platform: argv[1],
      handle: argv[2].toLowerCase(),
      sampleN: Number.parseInt(argv[3], 10),
      seed: argv[4] ? Number.parseInt(argv[4], 10) : 1,
    };
  }
  if (argv[0] === '--pgn' && argv[1]) {
    return { mode: 'pgn', pgnPath: argv[1] };
  }
  throw new Error(
    'Usage: stage3 --self <platform> <handle>\n' +
      '       stage3 --self-sample <platform> <handle> <N> [seed]\n' +
      '       stage3 --pgn <file.pgn>',
  );
}

/** Deterministic small PRNG (mulberry32) — same seed = same sample. */
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
  // Fisher-Yates partial shuffle
  for (let i = idx.length - 1; i > idx.length - 1 - n; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return idx.slice(idx.length - n).map((i) => arr[i]!);
}

async function loadSelfGames(
  sql: ReturnType<typeof getGamesDb>['client'],
  platform: string,
  handle: string,
): Promise<GameRow[]> {
  const rows = await sql<
    {
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
    }[]
  >`
    SELECT
      white_handle_snapshot, black_handle_snapshot, white_rating, black_rating,
      result, time_class, opening_eco, ply_count, termination, played_at
    FROM games
    WHERE source = ${platform}
      AND (LOWER(white_handle_snapshot) = ${handle} OR LOWER(black_handle_snapshot) = ${handle})
  `;
  return rows.map((r) => {
    const playedAt = new Date(r.played_at);
    const isWhite = (r.white_handle_snapshot ?? '').toLowerCase() === handle;
    return {
      color: isWhite ? 'white' : 'black',
      result: r.result,
      time_class: r.time_class,
      opening_eco: r.opening_eco,
      ply_count: r.ply_count,
      termination: r.termination,
      opponent_rating: isWhite ? r.black_rating : r.white_rating,
      played_at: playedAt,
    };
  });
}

async function loadPgnFile(pgnPath: string, claimedHandle: string | null): Promise<GameRow[]> {
  const text = await readFile(pgnPath, 'utf8');
  const stream = Readable.from([text]);
  const out: GameRow[] = [];

  for await (const parsed of streamGames(stream)) {
    const processed = processGame(parsed);
    if (!processed) continue;
    const h = parsed.headers;
    const white = (h.White ?? '').toLowerCase();
    // For sample-game mode, decide which side is the target. If a
    // claimedHandle is given, use it. Otherwise: default to White.
    const targetIsWhite = claimedHandle ? white === claimedHandle : true;
    const result = processed.game.result;
    if (result === '*') continue; // unfinished game — skip
    out.push({
      color: targetIsWhite ? 'white' : 'black',
      result,
      time_class: processed.game.time_class,
      opening_eco: processed.game.opening_eco,
      ply_count: processed.game.ply_count,
      termination: processed.game.termination,
      opponent_rating: targetIsWhite ? processed.game.black_rating : processed.game.white_rating,
      played_at: processed.game.played_at,
    });
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { client } = getGamesDb();
  try {
    let games: GameRow[];
    let label: string;
    if (args.mode === 'self') {
      games = await loadSelfGames(client, args.platform!, args.handle!);
      label = `${args.platform}/${args.handle} (self-test)`;
    } else if (args.mode === 'self-sample') {
      const all = await loadSelfGames(client, args.platform!, args.handle!);
      games = sampleN(all, args.sampleN!, args.seed!);
      label = `${args.platform}/${args.handle} (sampled ${games.length}/${all.length}, seed=${args.seed})`;
    } else {
      games = await loadPgnFile(args.pgnPath!, null);
      label = `PGN file ${args.pgnPath}`;
    }

    console.log(`[stage3] target=${label}  games=${games.length}`);
    if (games.length === 0) {
      console.log('[stage3] no games found for target.');
      return;
    }

    const t0 = Date.now();
    const target = extractFeaturesV0(games);
    const matches = await rankFingerprints(client, target, { topK: 10, minGamesWindow: 10 });
    const dt = ((Date.now() - t0) / 1000).toFixed(2);

    console.log(`\n[stage3] top 10 candidates (${dt}s):`);
    for (const [i, m] of matches.entries()) {
      const c = m.components;
      console.log(
        `  ${String(i + 1).padStart(2)}. ${m.platform}/${m.handle.padEnd(22)} ` +
          `score=${(m.combined_score * 100).toFixed(1).padStart(5)}%  ` +
          `eco_W=${(c.eco_white * 100).toFixed(0).padStart(3)}  ` +
          `eco_B=${(c.eco_black * 100).toFixed(0).padStart(3)}  ` +
          `time=${(c.time_class * 100).toFixed(0).padStart(3)}  ` +
          `opp=${(c.opp_rating * 100).toFixed(0).padStart(3)}  ` +
          `games=${m.games_window}`,
      );
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('stage3 failed:', err);
  process.exit(1);
});
