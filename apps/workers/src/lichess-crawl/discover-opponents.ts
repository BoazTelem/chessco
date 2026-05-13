/**
 * Transitive opponent discovery for the Lichess crawler.
 *
 * After each successful ingestBatch within a user_games stream, scan
 * the games we just inserted for opponent handles. Any opponent we
 * haven't seen before gets enqueued at priority=0. ON CONFLICT (handle)
 * makes it idempotent.
 *
 * Together with the dump-scan seed (extract-handles.ts), this lets the
 * Lichess corpus grow organically beyond the legacy 2013 seed.
 */
import type postgres from 'postgres';
import type { ProcessedGame } from '../lichess-dumps/parse-game';

export async function enqueueLichessOpponents(
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
    handle: h,
    priority: 0,
  }));

  const result = await sql<{ id: string }[]>`
    INSERT INTO lichess_crawl_queue
      ${insert(rows, 'handle', 'priority')}
    ON CONFLICT (handle) DO NOTHING
    RETURNING id
  `;
  return result.length;
}
