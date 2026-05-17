/**
 * TWIC ingester — fetches TWIC issue zips, parses each game, and inserts
 * a staging row into external_pgn_sources for every game in the issue.
 *
 * This is Phase 1 step 2 of the external-PGN auto-fetch workstream
 * (docs/external-pgn-auto-fetch.md). Sibling of probe.ts: same fetch +
 * stream pipeline, but writes to the games-corpus DB instead of just
 * reporting stats.
 *
 * Two downstream passes consume the resulting rows:
 *   - FIDE resolver fills white_fide_id / black_fide_id (next commit)
 *   - Games ingester parses raw_pgn into games/moves/positions (later)
 *
 * Usage:
 *   pnpm --filter @chessco/workers external:twic:ingest -- --issue 1521
 *   pnpm --filter @chessco/workers external:twic:ingest -- --issues 1518,1519,1520,1521
 *   pnpm --filter @chessco/workers external:twic:ingest -- --issue 1521 --dry-run
 *   pnpm --filter @chessco/workers external:twic:ingest -- --issue 1521 --max-games 100
 *
 * Idempotent: ON CONFLICT (source, source_url) DO NOTHING — re-running an
 * issue skips rows we've already staged.
 */
import 'dotenv/config';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import unzipper from 'unzipper';
import { getGamesDb } from '../../db';
import { streamGames } from '../../lichess-dumps/pgn-stream';
import { batchInsertExternalPgn, buildExternalPgnRow, type ExternalPgnRow } from '../lib/storage';

const USER_AGENT = 'chessco/0.1 (+https://chessco.org)';
const TWIC_ZIP_URL = (issue: number) => `https://theweekinchess.com/zips/twic${issue}g.zip`;
const FLUSH_EVERY = 500; // games per batch INSERT

interface CliArgs {
  issues: number[];
  maxGames: number | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { issues: [], maxGames: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--issue' && argv[i + 1]) {
      out.issues.push(Number.parseInt(argv[++i]!, 10));
    } else if (a === '--issues' && argv[i + 1]) {
      out.issues.push(
        ...argv[++i]!.split(/[\s,]+/)
          .map((s) => Number.parseInt(s.trim(), 10))
          .filter((n) => Number.isFinite(n) && n > 0),
      );
    } else if (a === '--max-games' && argv[i + 1]) {
      out.maxGames = Number.parseInt(argv[++i]!, 10);
    } else if (a === '--dry-run') {
      out.dryRun = true;
    } else {
      throw new Error(`Unrecognized arg: ${a}`);
    }
  }
  if (out.issues.length === 0) {
    throw new Error('Specify at least one issue with --issue NNNN or --issues N1,N2,…');
  }
  return out;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

async function downloadIssue(issue: number, destZipPath: string): Promise<number> {
  const url = TWIC_ZIP_URL(issue);
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/zip' },
  });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const writeStream = createWriteStream(destZipPath);
  await pipeline(
    Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
    writeStream,
  );
  const { size } = await stat(destZipPath);
  return size;
}

async function openPgnInZip(zipPath: string): Promise<Readable> {
  const directory = await unzipper.Open.file(zipPath);
  const pgnEntry = directory.files.find((f) => f.path.toLowerCase().endsWith('.pgn'));
  if (!pgnEntry) {
    const names = directory.files.map((f) => f.path).join(', ');
    throw new Error(`No .pgn entry in ${zipPath}. Entries: ${names}`);
  }
  return pgnEntry.stream();
}

interface IssueResult {
  issue: number;
  gamesSeen: number;
  inserted: number;
  conflicts: number;
  durationMs: number;
}

async function ingestIssue(
  sql: ReturnType<typeof getGamesDb>['client'],
  args: CliArgs,
  issue: number,
): Promise<IssueResult> {
  const t0 = Date.now();
  const tempDir = await mkdtemp(join(tmpdir(), 'chessco-twic-'));
  const zipPath = join(tempDir, `twic${issue}g.zip`);
  const sourceIssue = `twic${issue}`;

  try {
    console.log(`[twic-ingest] issue ${issue}: downloading ${TWIC_ZIP_URL(issue)}`);
    const bytes = await downloadIssue(issue, zipPath);
    console.log(
      `[twic-ingest] issue ${issue}: ${(bytes / 1024).toFixed(1)} KiB downloaded ` +
        `in ${Date.now() - t0} ms`,
    );

    const pgnStream = await openPgnInZip(zipPath);

    const pending: ExternalPgnRow[] = [];
    let gamesSeen = 0;
    let inserted = 0;
    let conflicts = 0;

    async function flush(): Promise<void> {
      if (pending.length === 0) return;
      if (args.dryRun) {
        // In dry-run we just count "would-have-inserted" and discard.
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
      const sourceUrl = `twic://${issue}/${ordinal}`;
      pending.push(buildExternalPgnRow(game, 'twic', sourceUrl, sourceIssue));

      if (pending.length >= FLUSH_EVERY) await flush();
      if (args.maxGames !== null && gamesSeen >= args.maxGames) break;
    }
    await flush();

    const durationMs = Date.now() - t0;
    console.log(
      `[twic-ingest] issue ${issue} DONE: games=${fmt(gamesSeen)} ` +
        `inserted=${fmt(inserted)} conflicts=${fmt(conflicts)} ` +
        `(${(durationMs / 1000).toFixed(1)}s)`,
    );

    return { issue, gamesSeen, inserted, conflicts, durationMs };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[twic-ingest] ${args.issues.length} issue(s)` +
      `${args.maxGames ? ` max-games=${args.maxGames}` : ''}` +
      `${args.dryRun ? ' DRY-RUN' : ''}`,
  );

  const { client: sql } = getGamesDb();
  try {
    const results: IssueResult[] = [];
    for (const issue of args.issues) {
      try {
        results.push(await ingestIssue(sql, args, issue));
      } catch (err) {
        console.error(
          `[twic-ingest] issue ${issue} FAILED: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (results.length > 0) {
      const totals = results.reduce(
        (acc, r) => ({
          gamesSeen: acc.gamesSeen + r.gamesSeen,
          inserted: acc.inserted + r.inserted,
          conflicts: acc.conflicts + r.conflicts,
          durationMs: acc.durationMs + r.durationMs,
        }),
        { gamesSeen: 0, inserted: 0, conflicts: 0, durationMs: 0 },
      );
      console.log(
        `\n[twic-ingest] grand total: ${fmt(totals.gamesSeen)} games seen across ` +
          `${results.length} issues; ${fmt(totals.inserted)} inserted, ` +
          `${fmt(totals.conflicts)} conflicts (skipped); ` +
          `${(totals.durationMs / 1000).toFixed(1)}s total`,
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('twic-ingest failed:', err);
  process.exit(1);
});
