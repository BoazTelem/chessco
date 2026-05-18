/**
 * FIDE-name resolver for staged external PGNs.
 *
 * Phase 1 step 3 of the external-PGN auto-fetch workstream. Reads rows
 * from external_pgn_sources (games-corpus DB) where fide_resolved_at IS
 * NULL, resolves white_name / black_name to federation_players.id (in
 * Supabase) via the shared resolver, and writes the resolved IDs back.
 *
 * Architecture choices:
 *   - Per-distinct-name resolution. Same player appears across many TWIC
 *     games per issue; we cache (name, rounded_elo) → fide_id within a
 *     run so we hit Supabase once per name.
 *   - Bulk UPDATE WHERE white_name = ANY(:names). Names are an indexed
 *     trigram column on the staging table so this is fast.
 *   - fide_resolved_at is set on EVERY row we touch (success or null),
 *     so re-runs only process the new arrivals. To force a re-resolve
 *     (e.g. after federation_players grew), `UPDATE external_pgn_sources
 *     SET fide_resolved_at = NULL` first.
 *
 * Usage:
 *   pnpm --filter @chessco/workers external:resolve-fide
 *   pnpm --filter @chessco/workers external:resolve-fide -- --source twic
 *   pnpm --filter @chessco/workers external:resolve-fide -- --issue twic1521
 *   pnpm --filter @chessco/workers external:resolve-fide -- --max-names 200 --dry-run
 *   pnpm --filter @chessco/workers external:resolve-fide -- --min-similarity 0.35 --max-elo-gap 200
 *
 * Idempotent against the staging table — only touches rows with
 * fide_resolved_at IS NULL.
 */
import 'dotenv/config';
import type postgres from 'postgres';
import { getDb, getGamesDb } from '../db';
import {
  DEFAULT_RESOLVER_CONFIG,
  resolveFideName,
  type FideMatch,
  type ResolverConfig,
} from './lib/fide-match';

interface CliArgs {
  source: string | null;
  issue: string | null;
  maxNames: number | null;
  dryRun: boolean;
  cfg: ResolverConfig;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    source: null,
    issue: null,
    maxNames: null,
    dryRun: false,
    cfg: { ...DEFAULT_RESOLVER_CONFIG },
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    else if (a === '--source' && argv[i + 1]) out.source = argv[++i]!;
    else if (a === '--issue' && argv[i + 1]) out.issue = argv[++i]!;
    else if (a === '--max-names' && argv[i + 1]) out.maxNames = Number.parseInt(argv[++i]!, 10);
    else if (a === '--min-similarity' && argv[i + 1])
      out.cfg.minSimilarity = Number.parseFloat(argv[++i]!);
    else if (a === '--max-elo-gap' && argv[i + 1])
      out.cfg.maxEloGap = Number.parseInt(argv[++i]!, 10);
    else if (a === '--dry-run') out.dryRun = true;
    else throw new Error(`Unrecognized arg: ${a}`);
  }
  return out;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

interface NameProbe {
  name: string;
  avg_elo: number | null;
  rows: number;
}

/** Read distinct (white_name, AVG(white_elo)) and (black_name, AVG(black_elo))
 *  tuples awaiting resolution. AVG smooths out per-event Elo drift across
 *  issues for the same player. */
async function readPendingProbes(
  gamesSql: postgres.Sql,
  args: CliArgs,
): Promise<{ white: NameProbe[]; black: NameProbe[] }> {
  const sourceFilter = args.source;
  const issueFilter = args.issue;
  const limit = args.maxNames;

  // White names
  const white = await gamesSql<{ name: string; avg_elo: string | null; rows: string }[]>`
    SELECT
      white_name AS name,
      AVG(white_elo)::text AS avg_elo,
      COUNT(*)::text AS rows
    FROM external_pgn_sources
    WHERE fide_resolved_at IS NULL
      AND white_name IS NOT NULL
      AND length(white_name) >= 3
      ${sourceFilter ? gamesSql`AND source = ${sourceFilter}` : gamesSql``}
      ${issueFilter ? gamesSql`AND source_issue = ${issueFilter}` : gamesSql``}
    GROUP BY white_name
    ORDER BY COUNT(*) DESC
    ${limit ? gamesSql`LIMIT ${limit}` : gamesSql``}
  `;

  const black = await gamesSql<{ name: string; avg_elo: string | null; rows: string }[]>`
    SELECT
      black_name AS name,
      AVG(black_elo)::text AS avg_elo,
      COUNT(*)::text AS rows
    FROM external_pgn_sources
    WHERE fide_resolved_at IS NULL
      AND black_name IS NOT NULL
      AND length(black_name) >= 3
      ${sourceFilter ? gamesSql`AND source = ${sourceFilter}` : gamesSql``}
      ${issueFilter ? gamesSql`AND source_issue = ${issueFilter}` : gamesSql``}
    GROUP BY black_name
    ORDER BY COUNT(*) DESC
    ${limit ? gamesSql`LIMIT ${limit}` : gamesSql``}
  `;

  const parse = (rows: typeof white): NameProbe[] =>
    rows.map((r) => ({
      name: r.name,
      avg_elo: r.avg_elo !== null ? Math.round(Number.parseFloat(r.avg_elo)) : null,
      rows: Number.parseInt(r.rows, 10),
    }));

  return { white: parse(white), black: parse(black) };
}

/**
 * Resolve a list of unique probes and return a (name → fide_id) map for the
 * ones that matched. Probes that don't match (or hit verdict thresholds)
 * are omitted; the worker still marks their rows fide_resolved_at = NOW().
 */
async function resolveProbes(
  supaSql: postgres.Sql,
  probes: NameProbe[],
  cfg: ResolverConfig,
  sideLabel: 'white' | 'black',
): Promise<Map<string, FideMatch>> {
  const out = new Map<string, FideMatch>();
  let processed = 0;
  for (const probe of probes) {
    processed++;
    try {
      const match = await resolveFideName(supaSql, probe.name, probe.avg_elo, cfg);
      if (match) out.set(probe.name, match);
    } catch (err) {
      console.warn(
        `  ! ${sideLabel} resolve "${probe.name}": ${err instanceof Error ? err.message : err}`,
      );
    }
    if (processed % 200 === 0) {
      console.log(`  · ${sideLabel} resolved ${fmt(processed)}/${fmt(probes.length)} probes`);
    }
  }
  return out;
}

/**
 * Bulk-update external_pgn_sources to fill {side}_fide_id based on a
 * (name → fide_id) map. Uses jsonb_to_recordset so we send one statement
 * for many name-row pairs.
 */
async function applyResolutions(
  gamesSql: postgres.Sql,
  side: 'white' | 'black',
  map: Map<string, FideMatch>,
): Promise<number> {
  if (map.size === 0) return 0;
  const payload = [...map.entries()].map(([name, match]) => ({
    name,
    fide_id: match.id,
  }));
  // 500 mappings per statement keeps the param count bounded.
  const CHUNK = 500;
  let touched = 0;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const slice = payload.slice(i, i + CHUNK);
    const result =
      side === 'white'
        ? await gamesSql<{ id: string }[]>`
          UPDATE external_pgn_sources
          SET white_fide_id = r.fide_id::uuid
          FROM jsonb_to_recordset(${JSON.stringify(slice)}::jsonb)
            AS r(name text, fide_id text)
          WHERE external_pgn_sources.white_name = r.name
            AND external_pgn_sources.fide_resolved_at IS NULL
          RETURNING external_pgn_sources.id::text
        `
        : await gamesSql<{ id: string }[]>`
          UPDATE external_pgn_sources
          SET black_fide_id = r.fide_id::uuid
          FROM jsonb_to_recordset(${JSON.stringify(slice)}::jsonb)
            AS r(name text, fide_id text)
          WHERE external_pgn_sources.black_name = r.name
            AND external_pgn_sources.fide_resolved_at IS NULL
          RETURNING external_pgn_sources.id::text
        `;
    touched += result.length;
  }
  return touched;
}

async function markResolvedAt(gamesSql: postgres.Sql, args: CliArgs): Promise<number> {
  const result = await gamesSql<{ id: string }[]>`
    UPDATE external_pgn_sources
    SET fide_resolved_at = NOW()
    WHERE fide_resolved_at IS NULL
      ${args.source ? gamesSql`AND source = ${args.source}` : gamesSql``}
      ${args.issue ? gamesSql`AND source_issue = ${args.issue}` : gamesSql``}
    RETURNING id::text
  `;
  return result.length;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const supabase = getDb();
  const games = getGamesDb();

  console.log(
    `[resolve-fide] config min-sim=${args.cfg.minSimilarity} max-elo-gap=${args.cfg.maxEloGap}` +
      `${args.source ? ` source=${args.source}` : ''}` +
      `${args.issue ? ` issue=${args.issue}` : ''}` +
      `${args.maxNames ? ` max-names=${args.maxNames}` : ''}` +
      `${args.dryRun ? ' DRY-RUN' : ''}`,
  );

  try {
    const t0 = Date.now();
    const { white, black } = await readPendingProbes(games.client, args);
    console.log(
      `[resolve-fide] distinct probes: white=${fmt(white.length)} black=${fmt(black.length)} ` +
        `(in ${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    );

    if (white.length === 0 && black.length === 0) {
      console.log('[resolve-fide] nothing to do.');
      return;
    }

    // Resolve sequentially per side — Supabase + Cloud SQL are different
    // connection pools so this isn't a contention issue, and the
    // resolution rate is bounded by Supabase trigram lookup cost.
    console.log('[resolve-fide] resolving white probes…');
    const whiteMap = await resolveProbes(supabase.client, white, args.cfg, 'white');
    console.log(
      `[resolve-fide] white: ${fmt(whiteMap.size)}/${fmt(white.length)} names resolved ` +
        `(${white.length > 0 ? ((whiteMap.size / white.length) * 100).toFixed(1) : '0'}%)`,
    );

    console.log('[resolve-fide] resolving black probes…');
    const blackMap = await resolveProbes(supabase.client, black, args.cfg, 'black');
    console.log(
      `[resolve-fide] black: ${fmt(blackMap.size)}/${fmt(black.length)} names resolved ` +
        `(${black.length > 0 ? ((blackMap.size / black.length) * 100).toFixed(1) : '0'}%)`,
    );

    if (args.dryRun) {
      console.log('\n[resolve-fide] DRY-RUN — would now apply:');
      const sampleWhite = [...whiteMap.entries()].slice(0, 5);
      const sampleBlack = [...blackMap.entries()].slice(0, 5);
      for (const [n, m] of sampleWhite) {
        console.log(`  white "${n}" → ${m.name} (fid ${m.id}, elo ${m.rating_standard})`);
      }
      for (const [n, m] of sampleBlack) {
        console.log(`  black "${n}" → ${m.name} (fid ${m.id}, elo ${m.rating_standard})`);
      }
      return;
    }

    const whiteTouched = await applyResolutions(games.client, 'white', whiteMap);
    const blackTouched = await applyResolutions(games.client, 'black', blackMap);
    console.log(
      `[resolve-fide] rows updated with white_fide_id: ${fmt(whiteTouched)}; ` +
        `black_fide_id: ${fmt(blackTouched)}`,
    );

    const marked = args.maxNames === null ? await markResolvedAt(games.client, args) : 0;
    if (args.maxNames === null) {
      console.log(`[resolve-fide] marked fide_resolved_at on ${fmt(marked)} rows`);
    } else {
      console.log(
        '[resolve-fide] skipped fide_resolved_at marking because --max-names is a partial pass',
      );
    }

    const totalDt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n[resolve-fide] DONE in ${totalDt}s`);
  } finally {
    await games.client.end({ timeout: 5 });
    await supabase.client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('resolve-fide failed:', err);
  process.exit(1);
});
