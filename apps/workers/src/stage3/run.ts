/**
 * Stage 3 V0 CLI. Three input modes + optional LLM rerank:
 *
 *   pnpm --filter @chessco/workers stage3 --self lichess karen_armenia
 *     Take that handle's own games as the target. Used as a smoke test —
 *     the same handle should rank #1 with score ~1.0.
 *
 *   pnpm --filter @chessco/workers stage3 --self-sample lichess karen 50 1
 *     Same as --self but use a deterministic sample of N games. Tests
 *     "different games of the same player" — the harder case.
 *
 *   pnpm --filter @chessco/workers stage3 --pgn path/to/games.pgn
 *     Parse the PGN file, treat the games as if from an unknown player,
 *     compute the fingerprint, and rank the cached corpus against it.
 *     This is the "by sample game" demo flow.
 *
 * Append `--llm` to any of the above to also run a DeepSeek rerank pass
 * (Stage D). The LLM gets the algorithmic top-10 + per-signal scores and
 * returns a JSON verdict + reordered top-K + per-candidate prose. Fails
 * soft when no provider is configured (just prints a note).
 *
 *   stage3 --self lichess karen --llm
 *   stage3 --pgn games.pgn --llm
 *
 * Either way: prints top 10 candidates with their component scores so
 * you can see WHY each match scored where it did, then (if --llm) the
 * LLM's holistic verdict.
 */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { Chess } from 'chess.js';
import { getGamesDb } from '../db';
import { extractFeaturesV0, type GameRow } from '../features/extract';
import { getProseProvider } from '../scout/llm-providers';
import { parsePgnToGameRows } from '../scout/pgn';
import { rankFingerprints, type Stage3Match } from './match';

/** Must match features/run.ts pgnToMoveSeqPrefix N — keys would otherwise
 *  not collide between the target and stored fingerprints. */
const MOVE_SEQ_PLY_COUNT = 12;

interface CliArgs {
  mode: 'self' | 'self-sample' | 'pgn';
  platform?: string;
  handle?: string;
  pgnPath?: string;
  /** For --self-sample: how many games to randomly pick from the handle's set. */
  sampleN?: number;
  /** Seed the sampler so the test is reproducible. */
  seed?: number;
  /** If true, run Stage D (DeepSeek rerank) after the algorithmic ranking. */
  llm?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  // --llm can appear anywhere; strip it first, then parse the positional
  // form (which has historically been `--self <p> <h>` etc.).
  const llm = argv.includes('--llm');
  const rest = argv.filter((a) => a !== '--llm');
  const base = parsePositional(rest);
  return { ...base, llm };
}

function parsePositional(argv: string[]): CliArgs {
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
    'Usage: stage3 --self <platform> <handle>           [--llm]\n' +
      '       stage3 --self-sample <platform> <handle> <N> [seed]  [--llm]\n' +
      '       stage3 --pgn <file.pgn>                       [--llm]',
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

/** Parse first MOVE_SEQ_PLY_COUNT plies SAN from a stored PGN. Empty when
 *  PGN is missing or unparseable. Mirrors features/run.ts so the keys here
 *  match what the corpus extractor produced. */
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

async function loadSelfGames(
  sql: ReturnType<typeof getGamesDb>['client'],
  platform: string,
  handle: string,
): Promise<GameRow[]> {
  // Pull pgn alongside the scalar columns so we can populate move_seq_prefix
  // for the target — without it, the matcher's two seq components evaluate
  // to 0 and a self-test scores ~0.54 instead of ~1.0.
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
      pgn: string | null;
    }[]
  >`
    SELECT
      white_handle_snapshot, black_handle_snapshot, white_rating, black_rating,
      result, time_class, opening_eco, ply_count, termination, played_at, pgn
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
      move_seq_prefix: pgnToMoveSeqPrefix(r.pgn),
    };
  });
}

/**
 * Load + parse a PGN file from any source (lichess / chess.com / TWIC /
 * pgnmentor / OTB tournament export). Uses the shared parsePgnToGameRows
 * which infers the target handle from the most-common name across the
 * paste (or accepts an explicit claim).
 *
 * Previously this called the lichess-dumps parser, which required a
 * lichess.org Site header and rejected every other source. It also
 * defaulted unclaimed games to White and never populated move_seq_prefix
 * — both fixed here.
 */
async function loadPgnFile(pgnPath: string, claimedHandle: string | null): Promise<GameRow[]> {
  const text = await readFile(pgnPath, 'utf8');
  return parsePgnToGameRows(text, claimedHandle);
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

    if (args.llm) {
      await llmRerank(matches, label);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

/** Stage D: hand the algorithmic top-10 to the configured LLM provider
 *  (DeepSeek by default) and print its holistic verdict + reranked order
 *  + per-candidate prose. Fail-soft when no provider is configured. */
async function llmRerank(matches: Stage3Match[], sourceLabel: string): Promise<void> {
  const provider = getProseProvider();
  if (!provider) {
    console.log(
      '\n[stage3] --llm: no provider configured (set SCOUT_PROSE_PROVIDER + DEEPSEEK_API_KEY in env).',
    );
    return;
  }
  if (matches.length === 0) {
    console.log('\n[stage3] --llm: no candidates to rerank.');
    return;
  }
  console.log(`\n[stage3] --llm: provider=${provider.name} model=${provider.model}`);

  const candidates = matches.slice(0, 10);
  const lines = candidates.map((m, i) => {
    const c = m.components;
    return [
      `[${i + 1}] ${m.platform}/${m.handle}`,
      `    algorithmic_confidence: ${(m.combined_score * 100).toFixed(0)}%`,
      `    games_window: ${m.games_window}`,
      `    signals: eco-W ${(c.eco_white * 100).toFixed(0)}% / eco-B ${(c.eco_black * 100).toFixed(0)}%; ` +
        `seq-W ${(c.move_seq_white * 100).toFixed(0)}% / seq-B ${(c.move_seq_black * 100).toFixed(0)}%; ` +
        `time ${(c.time_class * 100).toFixed(0)}%; ` +
        `opp_rating ${(c.opp_rating * 100).toFixed(0)}%; ` +
        `cp_loss ${(c.cp_loss * 100).toFixed(0)}%`,
    ].join('\n');
  });

  const prompt = `Judging which chess account fingerprint best matches the sample-game target. The algorithm has produced ranked candidates with per-signal cosine/gaussian scores. Synthesize the evidence holistically and decide.

TARGET: ${sourceLabel}

CANDIDATES (ranked by algorithm, top 10):
${lines.join('\n')}

Reasoning guidelines:
- Default to algorithmic ordering; only override with a SPECIFIC structured-signal reason. Do NOT swap candidates whose algorithmic scores are within 0.05 of each other unless a concrete signal explains it.
- ECO + move-sequence overlap is highly identifying. cp_loss disagreement with claimed rating is a red flag for fake accounts.
- Be honest about weak matches. If nothing's compelling, set confidence "low" and explain why.

Return STRICT JSON only:

{
  "verdict": {
    "best_match": "<platform>/<handle>",
    "confidence": "high" | "medium" | "low",
    "reasoning": "One paragraph synthesizing the verdict."
  },
  "order": ["<platform>/<handle>", "<platform>/<handle>", "..."],
  "prose": {
    "<platform>/<handle>": "One concise sentence (≤25 words).",
    "<platform>/<handle>": "..."
  }
}

Use exact "platform/handle" keys from the candidates above.`;

  const t0 = Date.now();
  let text: string;
  try {
    text = await provider.generate({ prompt, maxTokens: 1500 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  generate failed: ${msg}`);
    return;
  }
  const dt = Date.now() - t0;
  console.log(`  (${dt}ms, ${text.length} chars)`);

  // Robust parse: first '{' to last '}' handles occasional preamble/postamble
  // from models that don't fully respect JSON-only requests.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let parsed: Record<string, unknown> | null = null;
  if (start >= 0 && end > start) {
    try {
      parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      // fall through
    }
  }
  if (!parsed) {
    console.log('  LLM returned unparseable JSON. Raw response:');
    console.log(`  ${text.slice(0, 400)}${text.length > 400 ? '…' : ''}`);
    return;
  }

  const v = parsed.verdict as Record<string, unknown> | undefined;
  if (v && typeof v === 'object') {
    console.log(`  verdict: ${v.best_match} (${v.confidence})`);
    console.log(`    ${v.reasoning}`);
  } else {
    console.log('  (no verdict block returned)');
  }
  const order = parsed.order;
  if (Array.isArray(order) && order.length > 0) {
    console.log(`  rerank order: ${order.join(' > ')}`);
  }
  const prose = parsed.prose;
  if (prose && typeof prose === 'object') {
    console.log('  prose:');
    for (const [k, vv] of Object.entries(prose as Record<string, unknown>)) {
      console.log(`    ${k}: ${vv}`);
    }
  }
}

main().catch((err) => {
  console.error('stage3 failed:', err);
  process.exit(1);
});
