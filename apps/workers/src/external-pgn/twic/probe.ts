/**
 * TWIC (The Week in Chess) accessibility + PGN-parsing probe.
 *
 * First concrete step of the external-PGN auto-fetch workstream
 * (docs/external-pgn-auto-fetch.md, Phase 1). This script fetches one
 * TWIC issue zip from theweekinchess.com, unzips, streams the contained
 * PGN file, and reports per-issue summary stats. Zero DB writes — purely
 * a proof-of-life that:
 *
 *   1. TWIC URLs are accessible from our network (no Cloudflare gate).
 *   2. The expected zip→pgn shape holds.
 *   3. Our existing streaming PGN parser (lichess-dumps/pgn-stream)
 *      consumes TWIC PGNs without modification.
 *   4. PGN header coverage is good enough for FIDE-name matching
 *      (we report White/Black name presence, Elo presence, date range).
 *
 * URL pattern: https://theweekinchess.com/zips/twic{NNNN}g.zip
 *   - `g` suffix is the games-only file (vs HTML/results files)
 *   - Issue 920 (May 2012) is the first issue published with this zip
 *     format; current issues are ~1500+.
 *
 * Usage:
 *   pnpm --filter @chessco/workers external:twic:probe -- --issue 1521
 *   pnpm --filter @chessco/workers external:twic:probe -- --issue 1521 --max-games 100
 *   pnpm --filter @chessco/workers external:twic:probe -- --issues 1518,1519,1520,1521
 *
 * Reports stdout-only. No DB connection. No persistence. The next step
 * (separate commit) adds the external_pgn_sources migration + insert path.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import unzipper from 'unzipper';
import { streamGames } from '../../lichess-dumps/pgn-stream';
import type { ParsedGame } from '../../lichess-dumps/types';

const USER_AGENT = 'chessco/0.1 (+https://chessco.org)';
const TWIC_ZIP_URL = (issue: number) => `https://theweekinchess.com/zips/twic${issue}g.zip`;

interface CliArgs {
  issues: number[];
  maxGames: number | null;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { issues: [], maxGames: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      continue;
    } else if (a === '--issue' && argv[i + 1]) {
      out.issues.push(Number.parseInt(argv[++i]!, 10));
    } else if (a === '--issues' && argv[i + 1]) {
      out.issues.push(
        ...argv[++i]!.split(/[\s,]+/)
          .map((s) => Number.parseInt(s.trim(), 10))
          .filter((n) => Number.isFinite(n) && n > 0),
      );
    } else if (a === '--max-games' && argv[i + 1]) {
      out.maxGames = Number.parseInt(argv[++i]!, 10);
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

interface ProbeStats {
  issue: number;
  bytesDownloaded: number;
  pgnEntry: string;
  pgnBytes: number;
  games: number;
  withWhite: number;
  withBlack: number;
  withWhiteElo: number;
  withBlackElo: number;
  withDate: number;
  withEvent: number;
  earliestDate: string | null;
  latestDate: string | null;
  sampleEvents: Set<string>;
  topWhiteNames: Map<string, number>;
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

interface ZipEntry {
  name: string;
  size: number;
}

async function listZipEntries(zipPath: string): Promise<ZipEntry[]> {
  const out: ZipEntry[] = [];
  const directory = await unzipper.Open.file(zipPath);
  for (const f of directory.files) {
    out.push({ name: f.path, size: f.uncompressedSize });
  }
  return out;
}

/** Open the PGN file inside a TWIC zip as a Node Readable stream. */
async function openPgnInZip(zipPath: string, entryName: string): Promise<Readable> {
  const directory = await unzipper.Open.file(zipPath);
  const entry = directory.files.find((f) => f.path === entryName);
  if (!entry) throw new Error(`Entry ${entryName} not in ${zipPath}`);
  // entry.stream() returns a Node Readable that yields the decompressed bytes.
  return entry.stream();
}

function summariseGame(game: ParsedGame, stats: ProbeStats): void {
  stats.games++;
  const h = game.headers;
  if (h.White) stats.withWhite++;
  if (h.Black) stats.withBlack++;
  if (h.WhiteElo) stats.withWhiteElo++;
  if (h.BlackElo) stats.withBlackElo++;
  if (h.Date) {
    stats.withDate++;
    if (!stats.earliestDate || h.Date < stats.earliestDate) stats.earliestDate = h.Date;
    if (!stats.latestDate || h.Date > stats.latestDate) stats.latestDate = h.Date;
  }
  if (h.Event) {
    stats.withEvent++;
    if (stats.sampleEvents.size < 10) stats.sampleEvents.add(h.Event);
  }
  if (h.White) {
    stats.topWhiteNames.set(h.White, (stats.topWhiteNames.get(h.White) ?? 0) + 1);
  }
}

async function probeIssue(issue: number, maxGames: number | null): Promise<ProbeStats> {
  const tempDir = await mkdtemp(join(tmpdir(), 'chessco-twic-'));
  const zipPath = join(tempDir, `twic${issue}g.zip`);

  try {
    console.log(`[twic-probe] issue ${issue}: downloading ${TWIC_ZIP_URL(issue)}`);
    const t0 = Date.now();
    const bytes = await downloadIssue(issue, zipPath);
    const dlMs = Date.now() - t0;
    console.log(`[twic-probe] issue ${issue}: ${(bytes / 1024).toFixed(1)} KiB in ${dlMs} ms`);

    const entries = await listZipEntries(zipPath);
    const pgnEntry = entries.find((e) => e.name.toLowerCase().endsWith('.pgn'));
    if (!pgnEntry) {
      throw new Error(`No .pgn entry in zip. Entries: ${entries.map((e) => e.name).join(', ')}`);
    }

    const stats: ProbeStats = {
      issue,
      bytesDownloaded: bytes,
      pgnEntry: pgnEntry.name,
      pgnBytes: pgnEntry.size,
      games: 0,
      withWhite: 0,
      withBlack: 0,
      withWhiteElo: 0,
      withBlackElo: 0,
      withDate: 0,
      withEvent: 0,
      earliestDate: null,
      latestDate: null,
      sampleEvents: new Set<string>(),
      topWhiteNames: new Map<string, number>(),
    };

    console.log(
      `[twic-probe] issue ${issue}: parsing ${pgnEntry.name} ` +
        `(${(pgnEntry.size / 1024).toFixed(1)} KiB uncompressed)`,
    );
    const pgnStream = await openPgnInZip(zipPath, pgnEntry.name);
    for await (const game of streamGames(pgnStream)) {
      summariseGame(game, stats);
      if (maxGames !== null && stats.games >= maxGames) break;
    }

    return stats;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function reportStats(s: ProbeStats): void {
  const pct = (n: number) => (s.games > 0 ? ((n / s.games) * 100).toFixed(1) : '0');
  console.log(`\n[twic-probe] issue ${s.issue} summary:`);
  console.log(`  pgn entry:        ${s.pgnEntry} (${(s.pgnBytes / 1024).toFixed(1)} KiB)`);
  console.log(`  games parsed:     ${fmt(s.games)}`);
  console.log(`  header coverage:`);
  console.log(`    White:          ${fmt(s.withWhite)} (${pct(s.withWhite)}%)`);
  console.log(`    Black:          ${fmt(s.withBlack)} (${pct(s.withBlack)}%)`);
  console.log(`    WhiteElo:       ${fmt(s.withWhiteElo)} (${pct(s.withWhiteElo)}%)`);
  console.log(`    BlackElo:       ${fmt(s.withBlackElo)} (${pct(s.withBlackElo)}%)`);
  console.log(`    Date:           ${fmt(s.withDate)} (${pct(s.withDate)}%)`);
  console.log(`    Event:          ${fmt(s.withEvent)} (${pct(s.withEvent)}%)`);
  console.log(`  date range:       ${s.earliestDate ?? 'n/a'} → ${s.latestDate ?? 'n/a'}`);
  if (s.sampleEvents.size > 0) {
    console.log(`  sample events:`);
    for (const ev of s.sampleEvents) console.log(`    · ${ev}`);
  }
  // Top 5 most frequent White names — sanity check that name field is FIDE-shaped.
  const topNames = [...s.topWhiteNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (topNames.length > 0) {
    console.log(`  top White names (sanity):`);
    for (const [name, n] of topNames) console.log(`    · ${name} (${n})`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[twic-probe] probing ${args.issues.length} issue(s)`);

  const all: ProbeStats[] = [];
  for (const issue of args.issues) {
    try {
      const stats = await probeIssue(issue, args.maxGames);
      reportStats(stats);
      all.push(stats);
    } catch (err) {
      console.error(
        `[twic-probe] issue ${issue} FAILED: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  if (all.length > 1) {
    const totalGames = all.reduce((sum, s) => sum + s.games, 0);
    const totalBytes = all.reduce((sum, s) => sum + s.bytesDownloaded, 0);
    console.log(
      `\n[twic-probe] grand total: ${fmt(totalGames)} games across ${all.length} issues, ` +
        `${(totalBytes / 1024).toFixed(1)} KiB downloaded`,
    );
  }
}

// Avoid the unused-import warning on createReadStream — it's part of the toolkit
// available for the next iteration (DB insertion uses a streamed read).
void createReadStream;

main().catch((err) => {
  console.error('twic-probe failed:', err);
  process.exit(1);
});
