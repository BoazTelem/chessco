/**
 * Seed lichess_crawl_queue from the games-corpus handles table.
 *
 * The MVP seed pool is every handle in `handles` with platform='lichess'
 * and games_seen >= --min-games (default 10). This pulls in the ~1,400
 * fingerprintable handles from the 2013-01 dump and any newer ones that
 * may have been added since.
 *
 * Single-DB seed (unlike chesscom which crosses Supabase → games-corpus).
 *
 * Usage:
 *   pnpm --filter @chessco/workers lichess:crawl:seed
 *   pnpm --filter @chessco/workers lichess:crawl:seed --min-games 5
 *   pnpm --filter @chessco/workers lichess:crawl:seed --limit 100
 *   pnpm --filter @chessco/workers lichess:crawl:seed --handle drnykterstein
 */
import 'dotenv/config';
import { getGamesDb } from '../db';
import { seedHandles } from './queue';

interface Args {
  minGames: number;
  limit: number | null;
  priority: number;
  handle: string | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { minGames: 10, limit: null, priority: 0, handle: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--min-games' && argv[i + 1]) out.minGames = Number.parseInt(argv[++i]!, 10);
    else if (a === '--limit' && argv[i + 1]) out.limit = Number.parseInt(argv[++i]!, 10);
    else if (a === '--priority' && argv[i + 1]) out.priority = Number.parseInt(argv[++i]!, 10);
    else if (a === '--handle' && argv[i + 1]) out.handle = argv[++i]!;
    else throw new Error(`Unrecognized arg: ${a}`);
  }
  return out;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { client } = getGamesDb();

  try {
    // Short-circuit: --handle bypasses the handles-table query entirely.
    if (args.handle) {
      const inserted = await seedHandles(client, [args.handle.toLowerCase()], args.priority);
      console.log(
        `[lichess-crawl:seed] handle=${args.handle}: ${inserted === 1 ? 'queued' : 'already queued'}`,
      );
      return;
    }

    console.log(
      `[lichess-crawl:seed] reading handles (platform=lichess, games_seen >= ${args.minGames})` +
        `${args.limit ? `, limit=${args.limit}` : ''}`,
    );

    type Row = { handle: string };
    const rows = args.limit
      ? await client<Row[]>`
          SELECT handle FROM handles
          WHERE platform = 'lichess' AND games_seen >= ${args.minGames}
          ORDER BY games_seen DESC, last_seen_at DESC
          LIMIT ${args.limit}
        `
      : await client<Row[]>`
          SELECT handle FROM handles
          WHERE platform = 'lichess' AND games_seen >= ${args.minGames}
          ORDER BY games_seen DESC, last_seen_at DESC
        `;

    console.log(`[lichess-crawl:seed] read ${fmt(rows.length)} lichess handles`);

    if (rows.length === 0) {
      console.log(
        '[lichess-crawl:seed] no rows to seed — run lichess:dump or features:run first to populate handles.',
      );
      return;
    }

    const handles = rows.map((r) => r.handle);
    const inserted = await seedHandles(client, handles, args.priority);
    console.log(
      `[lichess-crawl:seed] inserted ${fmt(inserted)} new rows ` +
        `(${fmt(handles.length - inserted)} already queued)`,
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('lichess-crawl:seed failed:', err);
  process.exit(1);
});
