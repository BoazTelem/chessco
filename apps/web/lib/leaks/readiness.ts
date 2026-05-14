import postgres from 'postgres';
import type { Platform } from './types';

let cachedGamesDb: ReturnType<typeof postgres> | null = null;

/**
 * Connection to the Google Cloud SQL `chessco-games` corpus DB used by
 * workers. Mirrors apps/workers/src/db.ts:getGamesDb but for web routes.
 * Requires GAMES_DATABASE_URL in the web env.
 */
export function getGamesDb(): ReturnType<typeof postgres> {
  if (cachedGamesDb) return cachedGamesDb;
  const url = process.env.GAMES_DATABASE_URL;
  if (!url) {
    throw new Error('GAMES_DATABASE_URL not set');
  }
  const sslmode = process.env.GAMES_DATABASE_SSLMODE ?? 'require';
  const ssl: false | { rejectUnauthorized: boolean } =
    sslmode === 'disable' ? false : { rejectUnauthorized: false };
  cachedGamesDb = postgres(url, {
    max: 4,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false,
    ssl,
  });
  return cachedGamesDb;
}

export interface CoverageReport {
  totalMoves: number;
  withCpLoss: number;
  coverage: number;
}

export async function moveEvalCoverage(args: {
  platform: Platform;
  handleNormalized: string;
  recentGames?: number;
}): Promise<CoverageReport> {
  const { platform, handleNormalized, recentGames = 100 } = args;
  const sql = getGamesDb();

  const rows = (await sql`
    WITH target_handle AS (
      SELECT id FROM handles
      WHERE platform = ${platform} AND LOWER(handle) = ${handleNormalized}
      LIMIT 1
    ),
    target_games AS (
      SELECT g.id
      FROM games g
      WHERE g.source = ${platform}
        AND (
          g.white_player_id = (SELECT id FROM target_handle)
          OR g.black_player_id = (SELECT id FROM target_handle)
        )
      ORDER BY g.played_at DESC
      LIMIT ${recentGames}
    )
    SELECT
      COUNT(*)::int AS total_moves,
      COUNT(*) FILTER (WHERE m.cp_loss IS NOT NULL)::int AS with_cp_loss
    FROM moves m
    WHERE m.game_id IN (SELECT id FROM target_games)
  `) as Array<{ total_moves: number; with_cp_loss: number }>;

  const row = rows[0] ?? { total_moves: 0, with_cp_loss: 0 };
  return {
    totalMoves: row.total_moves,
    withCpLoss: row.with_cp_loss,
    coverage: row.total_moves > 0 ? row.with_cp_loss / row.total_moves : 0,
  };
}

export interface RepertoireReadiness {
  white: boolean;
  black: boolean;
}

export async function repertoireReadiness(args: {
  platform: Platform;
  handleNormalized: string;
}): Promise<RepertoireReadiness> {
  const sql = getGamesDb();
  const rows = (await sql`
    SELECT pr.color
    FROM player_repertoires pr
    WHERE pr.player_id IN (
      SELECT id FROM handles
      WHERE platform = ${args.platform}
        AND LOWER(handle) = ${args.handleNormalized}
    )
  `) as Array<{ color: 'white' | 'black' }>;

  let white = false;
  let black = false;
  for (const r of rows) {
    if (r.color === 'white') white = true;
    if (r.color === 'black') black = true;
  }
  return { white, black };
}
