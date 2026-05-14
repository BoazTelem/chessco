import postgres from 'postgres';
import type { MoveQualityIndex, Platform } from './types';

const RECENT_GAMES = 200;
const MIN_PLY = 1;
const MAX_PLY = 60;

/**
 * Aggregate move quality for an opponent's recent games. Keyed by
 * "${fenKey}|${uci}" so the leaks scorer can look up "how often, and how
 * badly, does this player play this move in this position?"
 *
 * fenKey here is the normalized first-4-fields FEN (matches the convention
 * used by player_repertoires keys). We compute it via a join to positions.
 */
export async function loadMoveQuality(args: {
  games: postgres.Sql;
  platform: Platform;
  handleNormalized: string;
}): Promise<MoveQualityIndex> {
  const { games, platform, handleNormalized } = args;

  interface Row {
    fen_key: string;
    uci: string;
    games_count: number;
    blunders: number;
    mistakes: number;
    sum_cp_loss: number;
  }

  // Move quality must include ONLY moves the target actually played, not
  // their opponents' moves. With 1-based ply numbering (parse-game.ts:107),
  // white plays on odd plies and black on even plies. We carry each game's
  // target_color forward and filter moves accordingly.
  const rows = await games<Row[]>`
    WITH target_handle AS (
      SELECT id FROM handles
      WHERE platform = ${platform} AND LOWER(handle) = ${handleNormalized}
      LIMIT 1
    ),
    target_games AS (
      SELECT g.id,
             CASE
               WHEN g.white_player_id = (SELECT id FROM target_handle) THEN 'white'
               WHEN g.black_player_id = (SELECT id FROM target_handle) THEN 'black'
             END AS target_color
      FROM games g
      WHERE g.source = ${platform}
        AND (
          g.white_player_id = (SELECT id FROM target_handle)
          OR g.black_player_id = (SELECT id FROM target_handle)
        )
      ORDER BY g.played_at DESC
      LIMIT ${RECENT_GAMES}
    ),
    target_moves AS (
      SELECT m.fen_before_id, m.uci, m.cp_loss,
             m.is_blunder, m.is_mistake
      FROM moves m
      JOIN target_games tg ON m.game_id = tg.id
      WHERE m.ply BETWEEN ${MIN_PLY} AND ${MAX_PLY}
        AND m.cp_loss IS NOT NULL
        AND (
          (tg.target_color = 'white' AND m.ply % 2 = 1)
          OR (tg.target_color = 'black' AND m.ply % 2 = 0)
        )
    )
    SELECT
      -- normalize FEN to first 4 fields (board, stm, castling, ep)
      array_to_string((string_to_array(p.fen, ' '))[1:4], ' ') AS fen_key,
      tm.uci,
      COUNT(*)::int AS games_count,
      COUNT(*) FILTER (WHERE tm.is_blunder)::int AS blunders,
      COUNT(*) FILTER (WHERE tm.is_mistake)::int AS mistakes,
      COALESCE(SUM(tm.cp_loss), 0)::int AS sum_cp_loss
    FROM target_moves tm
    JOIN positions p ON p.id = tm.fen_before_id
    GROUP BY 1, tm.uci
  `;

  const out: MoveQualityIndex = new Map();
  for (const r of rows) {
    out.set(`${r.fen_key}|${r.uci}`, {
      gamesCount: r.games_count,
      blunderRate: r.games_count > 0 ? r.blunders / r.games_count : 0,
      mistakeRate: r.games_count > 0 ? r.mistakes / r.games_count : 0,
      avgCpLoss: r.games_count > 0 ? r.sum_cp_loss / r.games_count : 0,
    });
  }
  return out;
}
