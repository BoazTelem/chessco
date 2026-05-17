/**
 * Seed lichess_crawl_queue with each perf's top-N leaderboard so the
 * crawler drains highly-rated handles before the priority-0 dump-seeded
 * backlog.
 *
 * Mirrors the role of `chesscom:titled` for the lichess side. The classic
 * `/api/users/titled` endpoint was deprecated by Lichess (404 as of 2026),
 * so we substitute the per-perf `/api/player/top/{nb}/{perf}` leaderboards.
 * Each perf gives up to 200 handles; the union across the four main perfs
 * (bullet, blitz, rapid, classical) lands ~500–800 distinct 2400+ accounts,
 * which is plenty to flip the crawl from "1800s dominating" to "top first".
 *
 * Unlike chess.com — where titled handles go to Supabase `platform_players`
 * first and then a separate seed step crosses over to games-corpus — lichess
 * has no equivalent directory table, so this writes straight to
 * `lichess_crawl_queue`. The existing `seedHandles` does ON CONFLICT
 * GREATEST(priority), so re-runs are cheap and only raise priority.
 *
 * Defaults:
 *   - perfs    = bullet,blitz,rapid,classical (top 200 each)
 *   - priority = 100 (matches chesscom T1; high enough to out-rank the
 *     0..24 priorities used by extract-handles.ts and seed.ts)
 *
 * Usage:
 *   pnpm --filter @chessco/workers lichess:titled
 *   pnpm --filter @chessco/workers lichess:titled --perfs blitz,rapid
 *   pnpm --filter @chessco/workers lichess:titled --top-n 100
 *   pnpm --filter @chessco/workers lichess:titled --priority 80
 */
import 'dotenv/config';
import { getGamesDb } from '../db';
import { LICHESS_TOP_PERFS, fetchTopLichessHandles, type LichessTopPerf } from '../lib/lichess-api';
import { seedHandles } from '../lichess-crawl/queue';

const DEFAULT_PERFS: LichessTopPerf[] = ['bullet', 'blitz', 'rapid', 'classical'];

interface Args {
  perfs: LichessTopPerf[];
  topN: number;
  priority: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { perfs: [...DEFAULT_PERFS], topN: 200, priority: 100 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--perfs' && argv[i + 1]) {
      const perfs = argv[++i]!.split(',').map((p) => p.trim());
      for (const p of perfs) {
        if (!LICHESS_TOP_PERFS.includes(p as LichessTopPerf)) {
          throw new Error(`Unknown perf: ${p}. Valid: ${LICHESS_TOP_PERFS.join(', ')}`);
        }
      }
      out.perfs = perfs as LichessTopPerf[];
    } else if (a === '--top-n' && argv[i + 1]) {
      out.topN = Number.parseInt(argv[++i]!, 10);
    } else if (a === '--priority' && argv[i + 1]) {
      out.priority = Number.parseInt(argv[++i]!, 10);
    } else throw new Error(`Unrecognized arg: ${a}`);
  }
  return out;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[lichess-titled] priority=${args.priority} top=${args.topN}×${args.perfs.join(',')}`,
  );

  const { client } = getGamesDb();
  try {
    const all = new Set<string>();
    for (const perf of args.perfs) {
      const t0 = Date.now();
      console.log(`\n→ /api/player/top/${args.topN}/${perf}`);
      const handles = await fetchTopLichessHandles(perf, args.topN);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  fetched ${fmt(handles.length)} handles (${dt}s)`);
      for (const h of handles) all.add(h);
    }

    if (all.size === 0) {
      console.log('\n[lichess-titled] nothing to seed.');
      return;
    }

    const list = [...all];
    console.log(
      `\n[lichess-titled] seeding ${fmt(list.length)} unique handles @ priority=${args.priority}`,
    );
    const inserted = await seedHandles(client, list, args.priority);
    console.log(
      `[lichess-titled] inserted ${fmt(inserted)} new rows ` +
        `(${fmt(list.length - inserted)} already at >= priority ${args.priority})`,
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('lichess-titled failed:', err);
  process.exit(1);
});
