/**
 * Transitive opponent discovery for the Lichess crawler.
 *
 * After each successful ingestBatch within a user_games stream, scan
 * the games we just inserted for opponent handles. Each opponent gets
 * enqueued with a priority derived from the highest opponent rating we
 * observed in this batch (mirrors chess.com's T1/T2/T3 tiering from
 * chesscom-crawl/seed.ts). Already-known handles get their priority
 * BUMPED UP via ON CONFLICT GREATEST so a freshly-discovered 2200 player
 * promotes a previously-discovered 1500 entry instead of being lost.
 *
 * Tier mapping (matches chess.com seed tiers):
 *   - 1800+ → priority 100  (T1: tournament-active strong)
 *   - 1500-1799 → priority 50  (T2: serious club)
 *   - 1200-1499 → priority 20  (T3: developing)
 *   - <1200 / unrated → priority 5  (long-tail; rarely useful)
 *
 * Together with the dump-scan seed (extract-handles.ts), this lets the
 * Lichess corpus grow organically beyond the legacy 2013 seed.
 */
import type postgres from 'postgres';
import type { ProcessedGame } from '../lichess-dumps/parse-game';

function ratingToPriority(rating: number | null): number {
  if (rating === null || rating < 1200) return 5;
  if (rating < 1500) return 20;
  if (rating < 1800) return 50;
  return 100;
}

function maxNullableRating(
  a: number | null | undefined,
  b: number | null | undefined,
): number | null {
  const left = a ?? -1;
  const right = b ?? -1;
  const max = Math.max(left, right);
  return max === -1 ? null : max;
}

export async function enqueueLichessOpponents(
  sql: postgres.Sql,
  ingestedGames: ProcessedGame[],
  currentHandle: string,
): Promise<number> {
  if (ingestedGames.length === 0) return 0;

  const current = currentHandle.toLowerCase();
  // Track HIGHEST observed rating per opponent across all games in this
  // batch. A player who appears as 1500 in one game and 2100 in another
  // gets the 2100-tier priority (we should crawl them at the strength
  // ceiling we know exists for them).
  const opponentMaxRating = new Map<string, number | null>();
  for (const g of ingestedGames) {
    const w = g.game.white_handle_snapshot?.toLowerCase();
    const b = g.game.black_handle_snapshot?.toLowerCase();
    const wr = g.game.white_rating;
    const br = g.game.black_rating;
    if (w && w !== current) {
      opponentMaxRating.set(w, maxNullableRating(opponentMaxRating.get(w), wr));
    }
    if (b && b !== current) {
      opponentMaxRating.set(b, maxNullableRating(opponentMaxRating.get(b), br));
    }
  }
  if (opponentMaxRating.size === 0) return 0;

  const insert = sql as unknown as (rows: object[], ...cols: string[]) => postgres.Helper<object[]>;

  const rows = [...opponentMaxRating.entries()].map(([handle, rating]) => ({
    handle,
    priority: ratingToPriority(rating),
  }));

  // Chunk inserts to stay under Postgres's 65534-bound-params ceiling.
  // 2 cols × 5000 rows = 10000 params; a Lichess user-export from a
  // prolific arena player can yield tens of thousands of distinct
  // opponents in one stream.
  const CHUNK = 5000;
  let totalInserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    // ON CONFLICT GREATEST: if the handle is already queued at a lower
    // tier, promote it to the higher tier we just observed. We never
    // demote (a known 2400 player who shows up as 1500 in this batch
    // keeps their 100 priority).
    const result = await sql<{ id: string }[]>`
      INSERT INTO lichess_crawl_queue
        ${insert(chunk, 'handle', 'priority')}
      ON CONFLICT (handle) DO UPDATE SET
        priority = GREATEST(EXCLUDED.priority, lichess_crawl_queue.priority)
      WHERE lichess_crawl_queue.priority < EXCLUDED.priority
      RETURNING id
    `;
    totalInserted += result.length;
  }
  return totalInserted;
}
