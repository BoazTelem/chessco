/**
 * Batch insert a buffer of ProcessedGame rows into chessco-games.
 *
 * One ingestBatch call = one transaction across positions/games/moves.
 * Position dedup is per-batch: we collect unique fen_hash values, insert
 * with ON CONFLICT DO NOTHING, then look up any pre-existing ids.
 */
import type postgres from 'postgres';
import { BATCH } from './config';
import type { ProcessedGame } from './parse-game';

export interface IngestStats {
  games: number;
  positions_inserted: number;
  positions_dedup_hits: number;
  moves: number;
}

/** fen_hash is bigint in Postgres; postgres-js v3.4 row/array helpers don't
 *  accept bigint in their public types, but they happily round-trip string ↔
 *  bigint columns. So at the wire boundary we always pass strings. */
interface PositionInsertRow {
  fen: string;
  fen_hash: string;
  side_to_move: 'w' | 'b';
  ply: number;
  eco: string | null;
  opening_name: string | null;
}

interface GameInsertRow {
  source: string;
  source_game_id: string;
  white_handle_snapshot: string | null;
  black_handle_snapshot: string | null;
  white_rating: number | null;
  black_rating: number | null;
  pgn: string;
  initial_fen: string | null;
  result: string;
  termination: string | null;
  time_control: string | null;
  time_class: string | null;
  opening_eco: string | null;
  opening_name: string | null;
  ply_count: number;
  played_at: string;
}

interface MoveInsertRow {
  game_id: string;
  ply: number;
  san: string;
  uci: string;
  fen_before_id: number;
  fen_after_id: number;
  clock_white_ms: number | null;
  clock_black_ms: number | null;
  eval_after_cp: number | null;
  eval_after_mate: number | null;
}

export async function ingestBatch(sql: postgres.Sql, batch: ProcessedGame[]): Promise<IngestStats> {
  if (batch.length === 0) {
    return { games: 0, positions_inserted: 0, positions_dedup_hits: 0, moves: 0 };
  }

  // ---- 1. Collect unique positions by fen_hash --------------------------
  const positionByHash = new Map<string, PositionInsertRow>();
  for (const g of batch) {
    for (const p of g.positions) {
      const k = p.fen_hash.toString();
      if (!positionByHash.has(k)) {
        positionByHash.set(k, {
          fen: p.fen,
          fen_hash: k,
          side_to_move: p.side_to_move,
          ply: p.ply,
          eco: p.eco,
          opening_name: p.opening_name,
        });
      }
    }
  }
  // Sort by fen_hash so concurrent workers inserting overlapping positions
  // acquire the unique-index locks in the same order — eliminates the
  // deadlock cycles we were seeing once 2+ workers ran against this DB.
  // Lexicographic sort is fine: any deterministic ordering prevents cycles.
  const uniquePositions = [...positionByHash.values()].sort((a, b) =>
    a.fen_hash < b.fen_hash ? -1 : a.fen_hash > b.fen_hash ? 1 : 0,
  );

  return sql.begin(async (tx) => {
    // postgres-js v3.4 typings reject `string[]` as column keys and the
    // inferred readonly tuple also fails the Helper<,T extends any[]>
    // bound. Cast to a loose multi-row INSERT helper — runtime is fine.
    const insert = tx as unknown as (
      rows: object[],
      ...cols: string[]
    ) => postgres.Helper<object[]>;

    // ---- 2. Upsert positions (dedup by fen_hash) — chunked --------------
    let newlyInserted = 0;
    const fenHashToId = new Map<string, number>();
    for (let i = 0; i < uniquePositions.length; i += BATCH.maxRowsPerInsert) {
      const chunk = uniquePositions.slice(i, i + BATCH.maxRowsPerInsert);
      const positionRows = await tx<{ id: number; fen_hash: bigint }[]>`
        INSERT INTO positions
          ${insert(chunk, 'fen', 'fen_hash', 'side_to_move', 'ply', 'eco', 'opening_name')}
        ON CONFLICT (fen_hash) DO NOTHING
        RETURNING id, fen_hash
      `;
      newlyInserted += positionRows.length;
      for (const r of positionRows) fenHashToId.set(r.fen_hash.toString(), r.id);
    }

    // ---- 3. Look up ids for positions that already existed --------------
    const missingHashes = uniquePositions
      .filter((p) => !fenHashToId.has(p.fen_hash))
      .map((p) => p.fen_hash);
    if (missingHashes.length > 0) {
      const existing = await tx<{ id: number; fen_hash: bigint }[]>`
        SELECT id, fen_hash FROM positions
        WHERE fen_hash = ANY(${tx.array(missingHashes)}::bigint[])
      `;
      for (const r of existing) fenHashToId.set(r.fen_hash.toString(), r.id);
    }

    // ---- 4. Insert games -----------------------------------------------
    // Sort by the UNIQUE-key columns (source, source_game_id, played_at) for
    // the same reason positions get sorted: two concurrent workers ingesting
    // overlapping games (e.g., Alice's archive of Alice-vs-Bob AND Bob's
    // archive of the same game) hit the same unique-index entries. Without
    // a consistent insertion order their lock acquisitions cycle. Sorting
    // eliminates the cycle.
    const gameRows: GameInsertRow[] = batch
      .map((b) => ({
        ...b.game,
        played_at: b.game.played_at.toISOString(),
      }))
      .sort((a, b) => {
        if (a.source !== b.source) return a.source < b.source ? -1 : 1;
        if (a.source_game_id !== b.source_game_id)
          return a.source_game_id < b.source_game_id ? -1 : 1;
        return a.played_at < b.played_at ? -1 : a.played_at > b.played_at ? 1 : 0;
      });
    // Chunk the games INSERT to stay under Postgres's 65534-bound-params
    // ceiling. 16 cols × 4000 rows = 64,000 — under the limit but tight.
    // Heavy tournament archives (philippians46/2025/03 etc.) yield 4000+
    // games in one buffer, which would otherwise overflow on the single
    // INSERT path. Use 3000 rows per chunk for comfortable headroom
    // (48,000 params, leaves ~17k overhead for postgres-js internals).
    const GAMES_CHUNK = 3000;
    const gameIdBySourceId = new Map<string, string>();
    for (let i = 0; i < gameRows.length; i += GAMES_CHUNK) {
      const chunk = gameRows.slice(i, i + GAMES_CHUNK);
      const inserted = await tx<{ id: string; source_game_id: string }[]>`
        INSERT INTO games
          ${insert(
            chunk,
            'source',
            'source_game_id',
            'white_handle_snapshot',
            'black_handle_snapshot',
            'white_rating',
            'black_rating',
            'pgn',
            'initial_fen',
            'result',
            'termination',
            'time_control',
            'time_class',
            'opening_eco',
            'opening_name',
            'ply_count',
            'played_at',
          )}
        ON CONFLICT (source, source_game_id, played_at) DO NOTHING
        RETURNING id, source_game_id
      `;
      for (const r of inserted) gameIdBySourceId.set(r.source_game_id, r.id);
    }

    // ---- 5. Insert moves -----------------------------------------------
    const moveRows: MoveInsertRow[] = [];
    for (const g of batch) {
      const gameId = gameIdBySourceId.get(g.game.source_game_id);
      if (!gameId) continue;
      const localHashByFen = new Map<string, string>();
      for (const p of g.positions) localHashByFen.set(p.fen, p.fen_hash.toString());

      for (const m of g.moves) {
        const beforeKey = localHashByFen.get(m.fen_before);
        const afterKey = localHashByFen.get(m.fen_after);
        if (!beforeKey || !afterKey) continue;
        const beforeId = fenHashToId.get(beforeKey);
        const afterId = fenHashToId.get(afterKey);
        if (beforeId === undefined || afterId === undefined) continue;
        moveRows.push({
          game_id: gameId,
          ply: m.ply,
          san: m.san,
          uci: m.uci,
          fen_before_id: beforeId,
          fen_after_id: afterId,
          clock_white_ms: m.clock_white_ms,
          clock_black_ms: m.clock_black_ms,
          eval_after_cp: m.eval_cp,
          eval_after_mate: m.eval_mate,
        });
      }
    }

    let movesInserted = 0;
    for (let i = 0; i < moveRows.length; i += BATCH.maxRowsPerInsert) {
      const chunk = moveRows.slice(i, i + BATCH.maxRowsPerInsert);
      const moveResult = await tx<{ id: number }[]>`
        INSERT INTO moves
          ${insert(
            chunk,
            'game_id',
            'ply',
            'san',
            'uci',
            'fen_before_id',
            'fen_after_id',
            'clock_white_ms',
            'clock_black_ms',
            'eval_after_cp',
            'eval_after_mate',
          )}
        RETURNING id
      `;
      movesInserted += moveResult.length;
    }

    return {
      games: gameIdBySourceId.size,
      positions_inserted: newlyInserted,
      positions_dedup_hits: uniquePositions.length - newlyInserted,
      moves: movesInserted,
    };
  });
}
