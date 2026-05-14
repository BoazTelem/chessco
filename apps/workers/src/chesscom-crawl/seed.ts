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
 * --priority-tier governs the top-down crawl order:
 *   T1: rating >= 1600 OR titled OR claimed-federation OR oauth → priority 100
 *   T2: rating 1300-1599 (no title)                              → priority  50
 *   T3: rating 1000-1299 (no title)                              → priority  20
 *
 * The hard floor at filter.ts minElo=1000 cuts everything below; the queue
 * priority drains the tiers from highest down. Run T1 first to populate
 * the corpus with the most-likely-paying audience before any T2/T3 effort.
 *
 * Usage:
 *   pnpm --filter @chessco/workers chesscom:crawl:seed
 *   pnpm --filter @chessco/workers chesscom:crawl:seed --limit 1000      # smoke test pool
 *   pnpm --filter @chessco/workers chesscom:crawl:seed --pulled-via titled
 *   pnpm --filter @chessco/workers chesscom:crawl:seed --priority 10
 *   pnpm --filter @chessco/workers chesscom:crawl:seed --priority-tier T1
 *   pnpm --filter @chessco/workers chesscom:crawl:seed --handle hikaru   # one-off
 */
import 'dotenv/config';
import type postgres from 'postgres';
import { getDb, getGamesDb } from '../db';
import { seedHandles } from './queue';

type PriorityTier = 'T1' | 'T2' | 'T3';

interface Args {
  limit: number | null;
  pulledVia: string | null;
  priority: number | null;
  priorityTier: PriorityTier | null;
  handle: string | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    limit: null,
    pulledVia: null,
    priority: null,
    priorityTier: null,
    handle: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit' && argv[i + 1]) out.limit = Number.parseInt(argv[++i]!, 10);
    else if (a === '--pulled-via' && argv[i + 1]) out.pulledVia = argv[++i]!;
    else if (a === '--priority' && argv[i + 1]) out.priority = Number.parseInt(argv[++i]!, 10);
    else if (a === '--priority-tier' && argv[i + 1]) {
      const t = argv[++i]!.toUpperCase();
      if (t !== 'T1' && t !== 'T2' && t !== 'T3') {
        throw new Error(`--priority-tier must be T1|T2|T3 (got ${t})`);
      }
      out.priorityTier = t;
    } else if (a === '--handle' && argv[i + 1]) out.handle = argv[++i]!;
    else throw new Error(`Unrecognized arg: ${a}`);
  }
  if (out.priority !== null && out.priorityTier !== null) {
    throw new Error('--priority and --priority-tier are mutually exclusive');
  }
  return out;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

/** Resolves the integer priority value for a tier, or 0 if no tier given. */
function tierPriority(tier: PriorityTier | null, override: number | null): number {
  if (override !== null) return override;
  if (tier === 'T1') return 100;
  if (tier === 'T2') return 50;
  if (tier === 'T3') return 20;
  return 0;
}

/**
 * Returns the rows matching the seed criteria. Composes WHERE on
 * `platform_players` from --pulled-via and --priority-tier. Both filters
 * intersect (AND); both are optional.
 */
async function selectHandles(
  sql: postgres.Sql,
  pulledVia: string | null,
  tier: PriorityTier | null,
  limit: number,
): Promise<string[]> {
  // postgres-js doesn't compose fragments cleanly; switch over the small
  // tier × pulledVia × limit matrix instead. Tier predicates below.
  //
  //   T1 (priority 100): rating_blitz >= 1600 OR rating_rapid >= 1600
  //                       OR title IS NOT NULL
  //                       OR claimed_federation_player_id IS NOT NULL
  //                       OR is_verified_oauth = true
  //   T2 (priority 50):  ((rating_blitz BETWEEN 1300 AND 1599)
  //                        OR (rating_rapid BETWEEN 1300 AND 1599))
  //                       AND title IS NULL
  //                       AND NOT (rating_blitz >= 1600 OR rating_rapid >= 1600)
  //   T3 (priority 20):  ((rating_blitz BETWEEN 1000 AND 1299)
  //                        OR (rating_rapid BETWEEN 1000 AND 1299))
  //                       AND title IS NULL
  //                       AND NOT (rating_blitz >= 1300 OR rating_rapid >= 1300)
  type Row = { handle: string };
  const hasLimit = limit > 0;

  if (tier === 'T1') {
    if (pulledVia) {
      const rows = hasLimit
        ? await sql<Row[]>`
            SELECT handle FROM platform_players
            WHERE platform = 'chess.com' AND pulled_via = ${pulledVia}
              AND (
                COALESCE(rating_blitz, 0) >= 1600
                OR COALESCE(rating_rapid, 0) >= 1600
                OR title IS NOT NULL
                OR claimed_federation_player_id IS NOT NULL
                OR is_verified_oauth = true
              )
            ORDER BY first_seen_at ASC
            LIMIT ${limit}`
        : await sql<Row[]>`
            SELECT handle FROM platform_players
            WHERE platform = 'chess.com' AND pulled_via = ${pulledVia}
              AND (
                COALESCE(rating_blitz, 0) >= 1600
                OR COALESCE(rating_rapid, 0) >= 1600
                OR title IS NOT NULL
                OR claimed_federation_player_id IS NOT NULL
                OR is_verified_oauth = true
              )
            ORDER BY first_seen_at ASC`;
      return rows.map((r) => r.handle.toLowerCase());
    }
    const rows = hasLimit
      ? await sql<Row[]>`
          SELECT handle FROM platform_players
          WHERE platform = 'chess.com'
            AND (
              COALESCE(rating_blitz, 0) >= 1600
              OR COALESCE(rating_rapid, 0) >= 1600
              OR title IS NOT NULL
              OR claimed_federation_player_id IS NOT NULL
              OR is_verified_oauth = true
            )
          ORDER BY first_seen_at ASC
          LIMIT ${limit}`
      : await sql<Row[]>`
          SELECT handle FROM platform_players
          WHERE platform = 'chess.com'
            AND (
              COALESCE(rating_blitz, 0) >= 1600
              OR COALESCE(rating_rapid, 0) >= 1600
              OR title IS NOT NULL
              OR claimed_federation_player_id IS NOT NULL
              OR is_verified_oauth = true
            )
          ORDER BY first_seen_at ASC`;
    return rows.map((r) => r.handle.toLowerCase());
  }

  if (tier === 'T2') {
    if (pulledVia) {
      const rows = hasLimit
        ? await sql<Row[]>`
            SELECT handle FROM platform_players
            WHERE platform = 'chess.com' AND pulled_via = ${pulledVia}
              AND title IS NULL
              AND (
                (rating_blitz BETWEEN 1300 AND 1599)
                OR (rating_rapid BETWEEN 1300 AND 1599)
              )
              AND NOT (
                COALESCE(rating_blitz, 0) >= 1600
                OR COALESCE(rating_rapid, 0) >= 1600
              )
            ORDER BY first_seen_at ASC
            LIMIT ${limit}`
        : await sql<Row[]>`
            SELECT handle FROM platform_players
            WHERE platform = 'chess.com' AND pulled_via = ${pulledVia}
              AND title IS NULL
              AND (
                (rating_blitz BETWEEN 1300 AND 1599)
                OR (rating_rapid BETWEEN 1300 AND 1599)
              )
              AND NOT (
                COALESCE(rating_blitz, 0) >= 1600
                OR COALESCE(rating_rapid, 0) >= 1600
              )
            ORDER BY first_seen_at ASC`;
      return rows.map((r) => r.handle.toLowerCase());
    }
    const rows = hasLimit
      ? await sql<Row[]>`
          SELECT handle FROM platform_players
          WHERE platform = 'chess.com'
            AND title IS NULL
            AND (
              (rating_blitz BETWEEN 1300 AND 1599)
              OR (rating_rapid BETWEEN 1300 AND 1599)
            )
            AND NOT (
              COALESCE(rating_blitz, 0) >= 1600
              OR COALESCE(rating_rapid, 0) >= 1600
            )
          ORDER BY first_seen_at ASC
          LIMIT ${limit}`
      : await sql<Row[]>`
          SELECT handle FROM platform_players
          WHERE platform = 'chess.com'
            AND title IS NULL
            AND (
              (rating_blitz BETWEEN 1300 AND 1599)
              OR (rating_rapid BETWEEN 1300 AND 1599)
            )
            AND NOT (
              COALESCE(rating_blitz, 0) >= 1600
              OR COALESCE(rating_rapid, 0) >= 1600
            )
          ORDER BY first_seen_at ASC`;
    return rows.map((r) => r.handle.toLowerCase());
  }

  if (tier === 'T3') {
    if (pulledVia) {
      const rows = hasLimit
        ? await sql<Row[]>`
            SELECT handle FROM platform_players
            WHERE platform = 'chess.com' AND pulled_via = ${pulledVia}
              AND title IS NULL
              AND (
                (rating_blitz BETWEEN 1000 AND 1299)
                OR (rating_rapid BETWEEN 1000 AND 1299)
              )
              AND NOT (
                COALESCE(rating_blitz, 0) >= 1300
                OR COALESCE(rating_rapid, 0) >= 1300
              )
            ORDER BY first_seen_at ASC
            LIMIT ${limit}`
        : await sql<Row[]>`
            SELECT handle FROM platform_players
            WHERE platform = 'chess.com' AND pulled_via = ${pulledVia}
              AND title IS NULL
              AND (
                (rating_blitz BETWEEN 1000 AND 1299)
                OR (rating_rapid BETWEEN 1000 AND 1299)
              )
              AND NOT (
                COALESCE(rating_blitz, 0) >= 1300
                OR COALESCE(rating_rapid, 0) >= 1300
              )
            ORDER BY first_seen_at ASC`;
      return rows.map((r) => r.handle.toLowerCase());
    }
    const rows = hasLimit
      ? await sql<Row[]>`
          SELECT handle FROM platform_players
          WHERE platform = 'chess.com'
            AND title IS NULL
            AND (
              (rating_blitz BETWEEN 1000 AND 1299)
              OR (rating_rapid BETWEEN 1000 AND 1299)
            )
            AND NOT (
              COALESCE(rating_blitz, 0) >= 1300
              OR COALESCE(rating_rapid, 0) >= 1300
            )
          ORDER BY first_seen_at ASC
          LIMIT ${limit}`
      : await sql<Row[]>`
          SELECT handle FROM platform_players
          WHERE platform = 'chess.com'
            AND title IS NULL
            AND (
              (rating_blitz BETWEEN 1000 AND 1299)
              OR (rating_rapid BETWEEN 1000 AND 1299)
            )
            AND NOT (
              COALESCE(rating_blitz, 0) >= 1300
              OR COALESCE(rating_rapid, 0) >= 1300
            )
          ORDER BY first_seen_at ASC`;
    return rows.map((r) => r.handle.toLowerCase());
  }

  // No tier filter — original behavior.
  if (pulledVia) {
    const rows = hasLimit
      ? await sql<Row[]>`
          SELECT handle FROM platform_players
          WHERE platform = 'chess.com' AND pulled_via = ${pulledVia}
          ORDER BY first_seen_at ASC
          LIMIT ${limit}`
      : await sql<Row[]>`
          SELECT handle FROM platform_players
          WHERE platform = 'chess.com' AND pulled_via = ${pulledVia}
          ORDER BY first_seen_at ASC`;
    return rows.map((r) => r.handle.toLowerCase());
  }
  const rows = hasLimit
    ? await sql<Row[]>`
        SELECT handle FROM platform_players
        WHERE platform = 'chess.com'
        ORDER BY first_seen_at ASC
        LIMIT ${limit}`
    : await sql<Row[]>`
        SELECT handle FROM platform_players
        WHERE platform = 'chess.com'
        ORDER BY first_seen_at ASC`;
  return rows.map((r) => r.handle.toLowerCase());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // One-off short circuit: --handle bypasses Supabase entirely.
  if (args.handle) {
    const { client: gamesClient } = getGamesDb();
    try {
      const priority = tierPriority(args.priorityTier, args.priority);
      const inserted = await seedHandles(gamesClient, [args.handle.toLowerCase()], priority);
      console.log(
        `[chesscom-crawl:seed] handle=${args.handle} priority=${priority}: ` +
          `${inserted === 1 ? 'queued' : 'already queued'}`,
      );
    } finally {
      await gamesClient.end({ timeout: 5 });
    }
    return;
  }

  const { client: supaClient } = getDb();
  const { client: gamesClient } = getGamesDb();

  try {
    const priority = tierPriority(args.priorityTier, args.priority);
    console.log(
      `[chesscom-crawl:seed] reading platform_players ` +
        `${args.priorityTier ? `tier=${args.priorityTier} ` : ''}` +
        `${args.pulledVia ? `pulled_via=${args.pulledVia} ` : ''}` +
        `priority=${priority} ` +
        `${args.limit ? `limit=${args.limit}` : ''}`,
    );

    const handles = await selectHandles(
      supaClient,
      args.pulledVia,
      args.priorityTier,
      args.limit ?? 0,
    );

    console.log(
      `[chesscom-crawl:seed] read ${fmt(handles.length)} chess.com handles from Supabase`,
    );

    if (handles.length === 0) {
      console.log(
        '[chesscom-crawl:seed] no rows to seed — have you run chesscom:titled / chesscom:country yet?',
      );
      return;
    }

    const inserted = await seedHandles(gamesClient, handles, priority);
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
