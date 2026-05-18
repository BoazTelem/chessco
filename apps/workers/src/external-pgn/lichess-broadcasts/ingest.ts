/**
 * Lichess broadcasts ingester — fetches PGNs from Lichess broadcasts,
 * parses each game, and inserts a staging row into external_pgn_sources
 * with source='lichess_broadcast'. Mirror of twic/ingest.ts; the same
 * downstream FIDE resolver + games-table ingester consume the rows.
 *
 * Why broadcasts:
 *   - LIVE coverage of OTB events (TWIC's lag is days/weeks).
 *   - Rich PGN headers: [WhiteFideId], [BlackFideId], [WhiteLichess],
 *     [BlackLichess] are commonly present, letting the resolver score
 *     against ground truth instead of pure trigram on names.
 *   - Strict superset of TWIC coverage for elite events.
 *
 * Architecture: docs/external-pgn-auto-fetch.md (Phase 1, extends to
 * cover Lichess broadcasts as a parallel source to TWIC).
 *
 * Endpoints:
 *   GET /api/broadcast/{broadcastTournamentId}.pgn   — whole tournament
 *   GET /api/broadcast/round/{broadcastRoundId}.pgn  — single round
 *
 * Either is acceptable; we use the tournament-level URL by default and
 * accept --round to scope. The `Site` PGN header carries the canonical
 * deep-link to the game on Lichess, used as source_url for idempotency.
 *
 * Usage:
 *   pnpm --filter @chessco/workers external:broadcasts:ingest -- --tour wij2025
 *   pnpm --filter @chessco/workers external:broadcasts:ingest -- --round abc12345
 *   pnpm --filter @chessco/workers external:broadcasts:ingest -- --tour wij2025 --dry-run
 *   pnpm --filter @chessco/workers external:broadcasts:ingest -- --tour wij2025 --max-games 50
 *
 * --tour ID:    canonical (use list.ts to discover IDs).
 * --round ID:   when you only want a single round (e.g. live refresh).
 * --dry-run:    parse + count, no DB writes.
 * --max-games:  cap (useful for shakedown on a long-running event).
 *
 * Idempotency: ON CONFLICT (source, source_url) DO NOTHING. Re-running an
 * active tournament during play picks up only the NEW games — finished
 * rounds skip silently. This is the live-refresh model: scheduled
 * re-runs every N minutes keep the corpus current.
 */
import 'dotenv/config';
import { Readable } from 'node:stream';
import { getGamesDb } from '../../db.js';
import { streamGames } from '../../lichess-dumps/pgn-stream.js';
import {
  batchInsertExternalPgn,
  buildExternalPgnRow,
  type ExternalPgnRow,
} from '../lib/storage.js';

const USER_AGENT = 'chessco/0.1 (+https://chessco.org)';
const FLUSH_EVERY = 500;
const LICHESS_BROADCAST_TOUR_PGN = (tour: string) =>
  `https://lichess.org/api/broadcast/${encodeURIComponent(tour)}.pgn`;
const LICHESS_BROADCAST_ROUND_PGN = (round: string) =>
  `https://lichess.org/api/broadcast/round/${encodeURIComponent(round)}.pgn`;

interface CliArgs {
  tour: string | null;
  round: string | null;
  maxGames: number | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { tour: null, round: null, maxGames: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tour' && argv[i + 1]) {
      out.tour = argv[++i]!;
    } else if (a === '--round' && argv[i + 1]) {
      out.round = argv[++i]!;
    } else if (a === '--max-games' && argv[i + 1]) {
      out.maxGames = Number.parseInt(argv[++i]!, 10);
    } else if (a === '--dry-run') {
      out.dryRun = true;
    } else {
      throw new Error(`Unrecognized arg: ${a}`);
    }
  }
  if (!out.tour && !out.round) {
    throw new Error('Pass --tour <id> or --round <id>');
  }
  if (out.tour && out.round) {
    throw new Error('Pass --tour OR --round, not both');
  }
  return out;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

async function fetchPgnStream(url: string): Promise<Readable> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/x-chess-pgn' },
  });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
}

export interface BroadcastIngestResult {
  url: string;
  gamesSeen: number;
  inserted: number;
  conflicts: number;
  durationMs: number;
}

export interface BroadcastIngestOpts {
  maxGames?: number | null;
  dryRun?: boolean;
}

/**
 * Ingest a single Lichess broadcast tournament's PGN feed into the
 * external_pgn_sources staging table. Reusable from the CLI main() and
 * from Inngest cron functions (apps/workers/src/inngest/external-pgn-broadcasts.ts).
 *
 * Idempotent via ON CONFLICT (source, source_url) DO NOTHING in
 * batchInsertExternalPgn — re-running an active tournament during play
 * surfaces only the new games as `inserted`, with already-staged games
 * reported as `conflicts` (no error).
 */
export async function ingestBroadcastByTour(
  sql: ReturnType<typeof getGamesDb>['client'],
  tour: string,
  opts: BroadcastIngestOpts = {},
): Promise<BroadcastIngestResult> {
  return ingestPgnUrl(
    sql,
    { tour, round: null, maxGames: opts.maxGames ?? null, dryRun: opts.dryRun ?? false },
    LICHESS_BROADCAST_TOUR_PGN(tour),
    `tour:${tour}`,
  );
}

/** Same as ingestBroadcastByTour but scoped to one round. */
export async function ingestBroadcastByRound(
  sql: ReturnType<typeof getGamesDb>['client'],
  round: string,
  opts: BroadcastIngestOpts = {},
): Promise<BroadcastIngestResult> {
  return ingestPgnUrl(
    sql,
    { tour: null, round, maxGames: opts.maxGames ?? null, dryRun: opts.dryRun ?? false },
    LICHESS_BROADCAST_ROUND_PGN(round),
    `round:${round}`,
  );
}

async function ingestPgnUrl(
  sql: ReturnType<typeof getGamesDb>['client'],
  args: CliArgs,
  pgnUrl: string,
  sourceIssue: string,
): Promise<BroadcastIngestResult> {
  const t0 = Date.now();
  console.log(`[broadcasts:ingest] fetching ${pgnUrl}`);
  const pgnStream = await fetchPgnStream(pgnUrl);

  const pending: ExternalPgnRow[] = [];
  let gamesSeen = 0;
  let inserted = 0;
  let conflicts = 0;

  async function flush(): Promise<void> {
    if (pending.length === 0) return;
    if (args.dryRun) {
      inserted += pending.length;
    } else {
      const r = await batchInsertExternalPgn(sql, pending);
      inserted += r.inserted;
      conflicts += r.conflicts;
    }
    pending.length = 0;
  }

  for await (const game of streamGames(pgnStream)) {
    const ordinal = gamesSeen;
    gamesSeen++;
    // Prefer the [Site] header as the canonical per-game URL (Lichess
    // broadcasts populate this with the lichess.org/{gameId} deep link).
    // Fall back to a synthetic URI keyed on tour/round + ordinal so
    // older broadcasts without Site still get a stable UNIQUE key.
    const siteHeader =
      typeof game.headers.Site === 'string' && game.headers.Site.trim().length > 0
        ? game.headers.Site.trim()
        : null;
    const sourceUrl = siteHeader ?? `lichess-broadcast://${sourceIssue}/${ordinal}`;
    pending.push(buildExternalPgnRow(game, 'lichess_broadcast', sourceUrl, sourceIssue));
    if (pending.length >= FLUSH_EVERY) await flush();
    if (args.maxGames !== null && gamesSeen >= args.maxGames) break;
  }
  await flush();

  const durationMs = Date.now() - t0;
  console.log(
    `[broadcasts:ingest] ${sourceIssue} DONE: games=${fmt(gamesSeen)} ` +
      `inserted=${fmt(inserted)} conflicts=${fmt(conflicts)} ` +
      `(${(durationMs / 1000).toFixed(1)}s)`,
  );
  return { url: pgnUrl, gamesSeen, inserted, conflicts, durationMs };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[broadcasts:ingest] ${args.tour ? `tour=${args.tour}` : `round=${args.round}`}` +
      `${args.maxGames ? ` max-games=${args.maxGames}` : ''}` +
      `${args.dryRun ? ' DRY-RUN' : ''}`,
  );

  const pgnUrl = args.tour
    ? LICHESS_BROADCAST_TOUR_PGN(args.tour)
    : LICHESS_BROADCAST_ROUND_PGN(args.round!);
  const sourceIssue = args.tour ? `tour:${args.tour}` : `round:${args.round}`;

  const { client: sql } = getGamesDb();
  try {
    await ingestPgnUrl(sql, args, pgnUrl, sourceIssue);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Run main() only when this file is invoked directly as a CLI. When
// imported (e.g. by Inngest crons), the exported functions are used
// without firing the CLI entry point.
const isCli = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`;
if (isCli) {
  main().catch((err) => {
    console.error('[broadcasts:ingest] failed:', err);
    process.exit(1);
  });
}
