import { sql } from './db';
import type { Result, Termination } from './types';

export interface MatchRow {
  id: string;
  challenge_id: string;
  opponent_id: string;
  creator_id: string;
  status: string;
  game_id: string | null;
}

export interface LiveGameRow {
  id: string;
  match_id: string;
  white_user_id: string;
  black_user_id: string;
  initial_fen: string;
  current_fen: string | null;
  pgn: string | null;
  time_control: string;
  white_time_ms: number | null;
  black_time_ms: number | null;
  status: 'live' | 'completed' | 'aborted' | 'abandoned';
  started_at: string;
}

/** Joined hydration query — match + creator (via challenge) + live_game. */
export async function loadMatchContext(matchId: string): Promise<{
  match: MatchRow;
  liveGame: LiveGameRow;
} | null> {
  const rows = (await sql`
    SELECT
      m.id, m.challenge_id, m.opponent_id, m.status, m.game_id,
      c.creator_id,
      lg.id AS lg_id,
      lg.match_id AS lg_match_id,
      lg.white_user_id, lg.black_user_id, lg.initial_fen,
      lg.current_fen, lg.pgn, lg.time_control,
      lg.white_time_ms, lg.black_time_ms, lg.status AS lg_status,
      lg.started_at
    FROM matches m
    JOIN challenges c ON c.id = m.challenge_id
    JOIN live_games lg ON lg.match_id = m.id
    WHERE m.id = ${matchId}
    LIMIT 1
  `) as Array<Record<string, unknown>>;

  const r = rows[0];
  if (!r) return null;

  return {
    match: {
      id: r.id as string,
      challenge_id: r.challenge_id as string,
      opponent_id: r.opponent_id as string,
      creator_id: r.creator_id as string,
      status: r.status as string,
      game_id: (r.game_id as string | null) ?? null,
    },
    liveGame: {
      id: r.lg_id as string,
      match_id: r.lg_match_id as string,
      white_user_id: r.white_user_id as string,
      black_user_id: r.black_user_id as string,
      initial_fen: r.initial_fen as string,
      current_fen: (r.current_fen as string | null) ?? null,
      pgn: (r.pgn as string | null) ?? null,
      time_control: r.time_control as string,
      white_time_ms: (r.white_time_ms as number | null) ?? null,
      black_time_ms: (r.black_time_ms as number | null) ?? null,
      status: r.lg_status as LiveGameRow['status'],
      started_at: r.started_at as string,
    },
  };
}

/** Persist a single ply + updated game state in one transaction. */
export async function persistMove(args: {
  matchId: string;
  liveGameId: string;
  ply: number;
  san: string;
  uci: string;
  whiteTimeMs: number;
  blackTimeMs: number;
  currentFen: string;
  pgn: string;
  clientTs: number | null;
}): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO match_moves (match_id, ply, san, uci, time_remaining_ms, client_timestamp)
      VALUES (
        ${args.matchId}, ${args.ply}, ${args.san}, ${args.uci},
        ${args.ply % 2 === 1 ? args.whiteTimeMs : args.blackTimeMs},
        ${args.clientTs ? new Date(args.clientTs).toISOString() : null}
      )
    `;
    await tx`
      UPDATE live_games
      SET pgn = ${args.pgn},
          current_fen = ${args.currentFen},
          white_time_ms = ${args.whiteTimeMs},
          black_time_ms = ${args.blackTimeMs}
      WHERE id = ${args.liveGameId}
    `;
    // The first persisted move flips matches.status from 'accepted' → 'live'.
    if (args.ply === 1) {
      await tx`
        UPDATE matches
        SET status = 'live', started_at = NOW()
        WHERE id = ${args.matchId} AND status = 'accepted'
      `;
    }
  });
}

/** Finalize a game: write result + termination + close out. Settlement runs separately. */
export async function finalizeGame(args: {
  matchId: string;
  liveGameId: string;
  result: Result;
  termination: Termination;
  whiteTimeMs: number;
  blackTimeMs: number;
  finalFen: string;
  pgn: string;
}): Promise<void> {
  const lgStatus =
    args.termination === 'aborted'
      ? 'aborted'
      : args.termination === 'creator_abandoned' || args.termination === 'opponent_abandoned'
        ? 'abandoned'
        : 'completed';

  await sql.begin(async (tx) => {
    await tx`
      UPDATE live_games
      SET result = ${args.result},
          termination = ${args.termination},
          status = ${lgStatus},
          current_fen = ${args.finalFen},
          pgn = ${args.pgn},
          white_time_ms = ${args.whiteTimeMs},
          black_time_ms = ${args.blackTimeMs},
          completed_at = NOW()
      WHERE id = ${args.liveGameId}
    `;

    // matches.status reflects the lifecycle, distinct from live_games.status.
    // 'completed' covers normal endings; abandonment paths use their own values.
    const matchStatus =
      args.termination === 'creator_abandoned'
        ? 'creator_abandoned'
        : args.termination === 'opponent_abandoned'
          ? 'abandoned'
          : args.termination === 'aborted'
            ? 'aborted'
            : 'completed';

    await tx`
      UPDATE matches
      SET status = ${matchStatus},
          completed_at = NOW()
      WHERE id = ${args.matchId}
    `;
  });
}
