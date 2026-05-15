/**
 * Bulk-insert ProcessedGame rows into chessco-games. Web-side mirror of
 * apps/workers/src/lichess-dumps/ingest.ts, duplicated rather than
 * cross-app imported per apps/web/lib/games-db.ts:5-7.
 */
import type postgres from 'postgres';

type SqlLike = postgres.Sql | postgres.TransactionSql;

export interface GameRow {
  source: 'lichess' | 'chess.com';
  source_game_id: string;
  white_handle_snapshot: string | null;
  black_handle_snapshot: string | null;
  white_rating: number | null;
  black_rating: number | null;
  pgn: string;
  initial_fen: string | null;
  result: '1-0' | '0-1' | '1/2-1/2';
  termination: string | null;
  time_control: string | null;
  time_class: 'bullet' | 'blitz' | 'rapid' | 'classical' | 'correspondence' | null;
  opening_eco: string | null;
  opening_name: string | null;
  ply_count: number;
  played_at: Date;
}

export interface PositionRow {
  fen: string;
  fen_hash: bigint;
  side_to_move: 'w' | 'b';
  ply: number;
  eco: string | null;
  opening_name: string | null;
}

export interface MoveRow {
  ply: number;
  san: string;
  uci: string;
  fen_before: string;
  fen_after: string;
  clock_white_ms: number | null;
  clock_black_ms: number | null;
  eval_cp: number | null;
  eval_mate: number | null;
}

export interface ProcessedGame {
  game: GameRow;
  positions: PositionRow[];
  moves: MoveRow[];
}

export interface IngestStats {
  games_inserted: number;
  games_deduped: number;
  positions_inserted: number;
  moves_inserted: number;
}

const MAX_ROWS_PER_INSERT = 4000;

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
    return { games_inserted: 0, games_deduped: 0, positions_inserted: 0, moves_inserted: 0 };
  }
  return sql.begin((tx) => ingestBatchInTransaction(tx, batch));
}

export async function ingestBatchInTransaction(
  tx: SqlLike,
  batch: ProcessedGame[],
): Promise<IngestStats> {
  if (batch.length === 0) {
    return { games_inserted: 0, games_deduped: 0, positions_inserted: 0, moves_inserted: 0 };
  }

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

  const uniquePositions = [...positionByHash.values()].sort((a, b) =>
    a.fen_hash < b.fen_hash ? -1 : a.fen_hash > b.fen_hash ? 1 : 0,
  );

  const insert = tx as unknown as (rows: object[], ...cols: string[]) => postgres.Helper<object[]>;

  let positionsInserted = 0;
  const fenHashToId = new Map<string, number>();
  for (let i = 0; i < uniquePositions.length; i += MAX_ROWS_PER_INSERT) {
    const chunk = uniquePositions.slice(i, i + MAX_ROWS_PER_INSERT);
    const rows = await tx<{ id: number; fen_hash: bigint }[]>`
      INSERT INTO positions
        ${insert(chunk, 'fen', 'fen_hash', 'side_to_move', 'ply', 'eco', 'opening_name')}
      ON CONFLICT (fen_hash) DO NOTHING
      RETURNING id, fen_hash
    `;
    positionsInserted += rows.length;
    for (const r of rows) fenHashToId.set(r.fen_hash.toString(), r.id);
  }

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

  const gameRows: GameInsertRow[] = batch
    .map((b) => ({ ...b.game, played_at: b.game.played_at.toISOString() }))
    .sort((a, b) => {
      if (a.source !== b.source) return a.source < b.source ? -1 : 1;
      if (a.source_game_id !== b.source_game_id)
        return a.source_game_id < b.source_game_id ? -1 : 1;
      return a.played_at < b.played_at ? -1 : a.played_at > b.played_at ? 1 : 0;
    });

  const gameIdBySourceId = new Map<string, string>();
  for (let i = 0; i < gameRows.length; i += 2000) {
    const chunk = gameRows.slice(i, i + 2000);
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
  for (let i = 0; i < moveRows.length; i += MAX_ROWS_PER_INSERT) {
    const chunk = moveRows.slice(i, i + MAX_ROWS_PER_INSERT);
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
    games_inserted: gameIdBySourceId.size,
    games_deduped: batch.length - gameIdBySourceId.size,
    positions_inserted: positionsInserted,
    moves_inserted: movesInserted,
  };
}
