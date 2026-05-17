/**
 * Coverage stats — Feature 1 (Name matching) dashboard generator.
 *
 * Writes apps/web/public/coverage-stats.json so the benchmarks page can
 * surface Name-matching coverage alongside the Games-matching accuracy
 * benchmark. The two features are tracked separately per Sprint plan:
 *
 *   Feature 1 (this file): federation_players → platform_players via
 *     hypothesis or reverse-claim — measured here as "what fraction of
 *     each FIDE tier has at least one matched online handle?"
 *
 *   Feature 2 (sparse-cascade-benchmark): PGN → handle accuracy — already
 *     produced by apps/workers/src/eval/sparse-cascade-benchmark.ts
 *
 * Tiers (Sprint plan):
 *   Titled              — any title in {GM, IM, FM, CM, WGM, WIM, WFM, WCM}
 *   FIDE 2200+
 *   FIDE 2000-2199
 *   FIDE 1800-1999
 *   FIDE 1400-1799
 *
 * For each tier:
 *   fide_pool        — count(federation_players)
 *   claimed          — count(distinct federation_players.id where there
 *                     exists a platform_players row with
 *                     claimed_federation_player_id = federation_players.id)
 *   coverage_pct     — claimed / fide_pool * 100
 *   by_platform      — claimed broken down by lichess / chess.com
 *
 * Usage:
 *   pnpm --filter @chessco/workers eval:coverage
 *   pnpm --filter @chessco/workers eval:coverage -- --out path/to/out.json
 */
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../db';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const DEFAULT_OUT = path.resolve(REPO_ROOT, 'apps/web/public/coverage-stats.json');

const TITLED_SET = ['GM', 'IM', 'FM', 'CM', 'WGM', 'WIM', 'WFM', 'WCM'] as const;

interface TierSpec {
  label: string;
  /** SQL predicate (parameter-free) appended to a SELECT against federation_players. */
  where: string;
  v1Target: number;
  realisticMax: number;
}

const TIERS: TierSpec[] = [
  {
    label: 'Titled (GM/IM/FM/CM/WGM/WIM/WFM/WCM)',
    where: `title = ANY(ARRAY['GM','IM','FM','CM','WGM','WIM','WFM','WCM'])`,
    v1Target: 80,
    realisticMax: 95,
  },
  {
    label: 'FIDE ≥ 2200',
    where: `rating_standard >= 2200`,
    v1Target: 40,
    realisticMax: 60,
  },
  {
    label: 'FIDE 2000-2199',
    where: `rating_standard BETWEEN 2000 AND 2199`,
    v1Target: 20,
    realisticMax: 30,
  },
  {
    label: 'FIDE 1800-1999',
    where: `rating_standard BETWEEN 1800 AND 1999`,
    v1Target: 10,
    realisticMax: 20,
  },
  {
    label: 'FIDE 1400-1799',
    where: `rating_standard BETWEEN 1400 AND 1799`,
    v1Target: 3,
    realisticMax: 5,
  },
];

interface TierResult {
  label: string;
  fide_pool: number;
  claimed_total: number;
  claimed_lichess: number;
  claimed_chesscom: number;
  coverage_pct: number;
  v1_target_pct: number;
  realistic_max_pct: number;
}

interface CliArgs {
  out: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' && argv[i + 1]) out.out = argv[++i]!;
    else throw new Error(`Unrecognized arg: ${a}`);
  }
  return out;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { client: sql } = getDb();

  try {
    console.log('[coverage-stats] computing tier coverage from Supabase…');

    const tierResults: TierResult[] = [];
    for (const tier of TIERS) {
      // FIDE pool size for the tier.
      const pool = await sql<{ n: string }[]>`
        SELECT COUNT(*)::text AS n FROM federation_players
        WHERE ${sql.unsafe(tier.where)}
      `;
      const fidePool = Number.parseInt(pool[0]?.n ?? '0', 10);

      // Distinct FIDE players within the tier with at least one claimed handle.
      const claimed = await sql<{ platform: string; n: string }[]>`
        SELECT pp.platform, COUNT(DISTINCT pp.claimed_federation_player_id)::text AS n
        FROM platform_players pp
        WHERE pp.claimed_federation_player_id IN (
          SELECT id FROM federation_players WHERE ${sql.unsafe(tier.where)}
        )
        GROUP BY pp.platform
      `;
      let claimedLi = 0;
      let claimedCc = 0;
      for (const row of claimed) {
        if (row.platform === 'lichess') claimedLi = Number.parseInt(row.n, 10);
        else if (row.platform === 'chess.com') claimedCc = Number.parseInt(row.n, 10);
      }
      // A single FIDE player can be claimed on BOTH platforms; we want the
      // union, not the sum, for the "fraction of tier covered" number.
      const claimedTotalRow = await sql<{ n: string }[]>`
        SELECT COUNT(DISTINCT pp.claimed_federation_player_id)::text AS n
        FROM platform_players pp
        WHERE pp.claimed_federation_player_id IN (
          SELECT id FROM federation_players WHERE ${sql.unsafe(tier.where)}
        )
      `;
      const claimedTotal = Number.parseInt(claimedTotalRow[0]?.n ?? '0', 10);
      const coverage = fidePool > 0 ? (claimedTotal / fidePool) * 100 : 0;

      tierResults.push({
        label: tier.label,
        fide_pool: fidePool,
        claimed_total: claimedTotal,
        claimed_lichess: claimedLi,
        claimed_chesscom: claimedCc,
        coverage_pct: Number(coverage.toFixed(2)),
        v1_target_pct: tier.v1Target,
        realistic_max_pct: tier.realisticMax,
      });

      console.log(
        `  · ${tier.label.padEnd(38)} pool=${fmt(fidePool).padStart(7)} ` +
          `claimed=${fmt(claimedTotal).padStart(6)} ` +
          `(li=${fmt(claimedLi)} cc=${fmt(claimedCc)}) ` +
          `cov=${coverage.toFixed(2)}% v1=${tier.v1Target}% max=${tier.realisticMax}%`,
      );
    }

    // Roll-up totals across platform_players (sanity).
    const platformTotals = await sql<{ platform: string; matchable: string; claimed: string }[]>`
      SELECT
        pp.platform,
        COUNT(*)::text AS matchable,
        COUNT(*) FILTER (WHERE pp.claimed_federation_player_id IS NOT NULL)::text AS claimed
      FROM platform_players pp
      GROUP BY pp.platform
    `;
    const platforms: Record<string, { matchable: number; claimed: number }> = {};
    for (const row of platformTotals) {
      platforms[row.platform] = {
        matchable: Number.parseInt(row.matchable, 10),
        claimed: Number.parseInt(row.claimed, 10),
      };
    }

    // FIDE total (1400+ pool, the relevant denominator).
    const totalRow = await sql<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM federation_players WHERE rating_standard >= 1400
    `;
    const fideTotal = Number.parseInt(totalRow[0]?.n ?? '0', 10);

    // Titled total = federation_players with any TITLED_SET title.
    const titledTotalRow = await sql<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM federation_players
      WHERE title = ANY(${[...TITLED_SET]}::text[])
    `;
    const titledTotal = Number.parseInt(titledTotalRow[0]?.n ?? '0', 10);

    const artifact = {
      as_of: new Date().toISOString(),
      methodology:
        'Feature 1 coverage = distinct federation_players.id with ≥1 platform_players row ' +
        'where claimed_federation_player_id is set. Counts the unique-FIDE-player axis, ' +
        'not handles. A player claimed on both lichess + chess.com counts once in the total.',
      totals: {
        fide_pool_1400_plus: fideTotal,
        titled_pool: titledTotal,
        platforms,
      },
      tiers: tierResults,
    };

    await mkdir(path.dirname(args.out), { recursive: true });
    await writeFile(args.out, JSON.stringify(artifact, null, 2) + '\n');
    console.log(`\n[coverage-stats] wrote ${args.out}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('coverage-stats failed:', err);
  process.exit(1);
});
