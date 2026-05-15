/**
 * Upsert a (platform, handle) row in the games-corpus `handles` table.
 *
 * `lookupHandleId` (apps/workers/src/repertoires/build.ts:284) reads from
 * this table — without an entry, the prepare-reports poller treats the
 * opponent as `unknown_handle` even when its games and moves are already
 * ingested. So every bulk-ingest must follow the games insert with this
 * upsert in the same transaction.
 *
 * Mirrors the upsert pattern in apps/workers/src/features/fast-lane.ts:365.
 */
import type postgres from 'postgres';

type SqlLike = postgres.Sql | postgres.TransactionSql;

export async function upsertHandle(
  sql: SqlLike,
  args: {
    platform: 'lichess' | 'chess.com';
    handle: string;
    gamesSeen: number;
    earliest: Date;
    latest: Date;
  },
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO handles (platform, handle, games_seen, first_seen_at, last_seen_at)
    VALUES (
      ${args.platform},
      ${args.handle.toLowerCase()},
      ${args.gamesSeen},
      ${args.earliest.toISOString()},
      ${args.latest.toISOString()}
    )
    ON CONFLICT (platform, handle) DO UPDATE SET
      games_seen = GREATEST(handles.games_seen, EXCLUDED.games_seen),
      first_seen_at = LEAST(handles.first_seen_at, EXCLUDED.first_seen_at),
      last_seen_at = GREATEST(handles.last_seen_at, EXCLUDED.last_seen_at)
    RETURNING id::text
  `;
  const id = rows[0]?.id;
  if (!id) {
    throw new Error(`handles upsert returned no rows for ${args.platform}/${args.handle}`);
  }
  return id;
}
