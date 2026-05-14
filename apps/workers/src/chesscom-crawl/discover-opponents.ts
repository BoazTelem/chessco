/**
 * Transitive opponent discovery for the chess.com crawler.
 *
 * After each successful ingestBatch, scan the games we just inserted
 * for opponent handles. Any opponent we haven't seen before is enqueued
 * as a new archives_list row at priority=0 (waits behind the explicitly
 * seeded titled+country pool, drains naturally after).
 *
 * This is how we expand from our 106k seed → the long tail of every
 * player anyone in the seed has played, recursively. ON CONFLICT on
 * (handle, kind, archive_url) makes it idempotent — re-running on the
 * same games is a no-op.
 */
import type postgres from 'postgres';
import type { ProcessedGame } from '../lichess-dumps/parse-game';

export async function enqueueOpponents(
  sql: postgres.Sql,
  ingestedGames: ProcessedGame[],
  currentHandle: string,
): Promise<number> {
  if (ingestedGames.length === 0) return 0;

  const current = currentHandle.toLowerCase();
  const opponents = new Set<string>();
  for (const g of ingestedGames) {
    const w = g.game.white_handle_snapshot?.toLowerCase();
    const b = g.game.black_handle_snapshot?.toLowerCase();
    if (w && w !== current) opponents.add(w);
    if (b && b !== current) opponents.add(b);
  }
  if (opponents.size === 0) return 0;

  const insert = sql as unknown as (rows: object[], ...cols: string[]) => postgres.Helper<object[]>;

  const rows = [...opponents].map((h) => ({
    kind: 'archives_list',
    handle: h,
    priority: 0,
  }));

  // Chunk inserts to stay under Postgres's 65534-bound-params ceiling.
  // 3 cols × 5000 rows = 15000 params; heavy tournament archives can
  // surface 25k+ distinct opponents which would otherwise blow past
  // the limit and put the archive_month into error_permanent.
  const CHUNK = 5000;
  let totalInserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const result = await sql<{ id: string }[]>`
      INSERT INTO chesscom_crawl_queue
        ${insert(chunk, 'kind', 'handle', 'priority')}
      ON CONFLICT (handle, kind, archive_url) DO NOTHING
      RETURNING id
    `;
    totalInserted += result.length;
  }
  return totalInserted;
}
