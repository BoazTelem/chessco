/**
 * Read + write the lichess_dump_runs row that tracks a dump's progress.
 * The worker writes counter updates every ~50 MB of compressed read so
 * progress survives crashes.
 */
import type postgres from 'postgres';

export interface DumpRunState {
  dump_id: string;
  status: 'running' | 'done' | 'failed';
  source_url: string;
  total_bytes: number | null;
  bytes_downloaded: number;
  games_seen: number;
  games_filtered_in: number;
  positions_inserted: number;
  moves_inserted: number;
  error: string | null;
}

export async function loadRun(sql: postgres.Sql, dumpId: string): Promise<DumpRunState | null> {
  const rows = await sql<DumpRunState[]>`
    SELECT
      dump_id, status, source_url,
      total_bytes, bytes_downloaded,
      games_seen, games_filtered_in,
      positions_inserted, moves_inserted, error
    FROM lichess_dump_runs WHERE dump_id = ${dumpId}
  `;
  return rows[0] ?? null;
}

export async function startRun(
  sql: postgres.Sql,
  dumpId: string,
  sourceUrl: string,
  totalBytes: number | undefined,
): Promise<void> {
  await sql`
    INSERT INTO lichess_dump_runs (dump_id, status, source_url, total_bytes)
    VALUES (${dumpId}, 'running', ${sourceUrl}, ${totalBytes ?? null})
    ON CONFLICT (dump_id) DO UPDATE SET
      status = 'running',
      source_url = EXCLUDED.source_url,
      total_bytes = COALESCE(EXCLUDED.total_bytes, lichess_dump_runs.total_bytes),
      started_at = NOW(),
      updated_at = NOW(),
      error = NULL
  `;
}

export async function tickRun(
  sql: postgres.Sql,
  dumpId: string,
  counters: {
    bytes_downloaded: number;
    games_seen: number;
    games_filtered_in: number;
    positions_inserted: number;
    moves_inserted: number;
  },
): Promise<void> {
  await sql`
    UPDATE lichess_dump_runs SET
      bytes_downloaded = ${counters.bytes_downloaded},
      games_seen = ${counters.games_seen},
      games_filtered_in = ${counters.games_filtered_in},
      positions_inserted = ${counters.positions_inserted},
      moves_inserted = ${counters.moves_inserted},
      updated_at = NOW()
    WHERE dump_id = ${dumpId}
  `;
}

export async function finishRun(
  sql: postgres.Sql,
  dumpId: string,
  status: 'done' | 'failed',
  err?: string,
): Promise<void> {
  await sql`
    UPDATE lichess_dump_runs SET
      status = ${status},
      completed_at = NOW(),
      updated_at = NOW(),
      error = ${err ?? null}
    WHERE dump_id = ${dumpId}
  `;
}
