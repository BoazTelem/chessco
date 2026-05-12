/**
 * Seed chesscom_crawl_queue from the Supabase platform_players directory.
 *
 * Reads every platform_players row where platform='chess.com' and inserts
 * one archives_list row per handle into the games-corpus crawl queue.
 *
 * Cross-DB: we open BOTH connections (Supabase via getDb, games-corpus via
 * getGamesDb). No FKs cross the boundary — just shuttle handles in memory.
 *
 * Idempotent: ON CONFLICT DO NOTHING in chesscom_crawl_queue means
 * re-running this is safe.
 *
 * Usage:
 *   pnpm --filter @chessco/workers chesscom:crawl:seed
 *   pnpm --filter @chessco/workers chesscom:crawl:seed --limit 1000      # smoke test pool
 *   pnpm --filter @chessco/workers chesscom:crawl:seed --pulled-via titled
 *   pnpm --filter @chessco/workers chesscom:crawl:seed --priority 10
 *   pnpm --filter @chessco/workers chesscom:crawl:seed --handle hikaru   # one-off
 */
import 'dotenv/config';
import { getDb, getGamesDb } from '../db';
import { seedHandles } from './queue';

interface Args {
  limit: number | null;
  pulledVia: string | null;
  priority: number;
  handle: string | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { limit: null, pulledVia: null, priority: 0, handle: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit' && argv[i + 1]) out.limit = Number.parseInt(argv[++i]!, 10);
    else if (a === '--pulled-via' && argv[i + 1]) out.pulledVia = argv[++i]!;
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

  // One-off short circuit: --handle bypasses Supabase entirely.
  if (args.handle) {
    const { client: gamesClient } = getGamesDb();
    try {
      const inserted = await seedHandles(gamesClient, [args.handle.toLowerCase()], args.priority);
      console.log(
        `[chesscom-crawl:seed] handle=${args.handle}: ${inserted === 1 ? 'queued' : 'already queued'}`,
      );
    } finally {
      await gamesClient.end({ timeout: 5 });
    }
    return;
  }

  const { client: supaClient } = getDb();
  const { client: gamesClient } = getGamesDb();

  try {
    console.log(
      `[chesscom-crawl:seed] reading platform_players ` +
        `${args.pulledVia ? `(pulled_via=${args.pulledVia}) ` : ''}` +
        `${args.limit ? `limit=${args.limit}` : ''}`,
    );

    type Row = { handle: string };
    const limit = args.limit ?? 0;
    const rows = args.pulledVia
      ? args.limit
        ? await supaClient<Row[]>`
            SELECT handle FROM platform_players
            WHERE platform = 'chess.com' AND pulled_via = ${args.pulledVia}
            ORDER BY first_seen_at ASC
            LIMIT ${limit}
          `
        : await supaClient<Row[]>`
            SELECT handle FROM platform_players
            WHERE platform = 'chess.com' AND pulled_via = ${args.pulledVia}
            ORDER BY first_seen_at ASC
          `
      : args.limit
        ? await supaClient<Row[]>`
            SELECT handle FROM platform_players
            WHERE platform = 'chess.com'
            ORDER BY first_seen_at ASC
            LIMIT ${limit}
          `
        : await supaClient<Row[]>`
            SELECT handle FROM platform_players
            WHERE platform = 'chess.com'
            ORDER BY first_seen_at ASC
          `;

    console.log(`[chesscom-crawl:seed] read ${fmt(rows.length)} chess.com handles from Supabase`);

    if (rows.length === 0) {
      console.log(
        '[chesscom-crawl:seed] no rows to seed — have you run chesscom:titled / chesscom:country yet?',
      );
      return;
    }

    const handles = rows.map((r) => r.handle.toLowerCase());
    const inserted = await seedHandles(gamesClient, handles, args.priority);
    console.log(
      `[chesscom-crawl:seed] inserted ${fmt(inserted)} new archives_list rows ` +
        `(${fmt(handles.length - inserted)} already queued)`,
    );
  } finally {
    await supaClient.end({ timeout: 5 });
    await gamesClient.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('chesscom-crawl:seed worker failed:', err);
  process.exit(1);
});
