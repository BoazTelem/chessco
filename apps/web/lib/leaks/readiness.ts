import postgres from 'postgres';
import type { Platform } from './types';

let cachedGamesDb: ReturnType<typeof postgres> | null = null;

/**
 * Connection to the Google Cloud SQL `chessco-games` corpus DB used by
 * workers. Mirrors apps/workers/src/db.ts:getGamesDb — accepts either
 * GAMES_DATABASE_URL or the split GAMES_DATABASE_HOST/PORT/USER/PASSWORD/NAME
 * envs. The split path avoids URL-encoding gotchas in passwords.
 */
export function getGamesDb(): ReturnType<typeof postgres> {
  if (cachedGamesDb) return cachedGamesDb;
  const sslmode = process.env.GAMES_DATABASE_SSLMODE ?? 'require';
  const ssl: false | { rejectUnauthorized: boolean } =
    sslmode === 'disable' ? false : { rejectUnauthorized: false };

  const url = process.env.GAMES_DATABASE_URL;
  if (url) {
    cachedGamesDb = postgres(url, {
      max: 4,
      idle_timeout: 30,
      connect_timeout: 10,
      prepare: false,
      ssl,
    });
    return cachedGamesDb;
  }

  const host = process.env.GAMES_DATABASE_HOST;
  const port = process.env.GAMES_DATABASE_PORT;
  const user = process.env.GAMES_DATABASE_USER;
  const password = process.env.GAMES_DATABASE_PASSWORD;
  const database = process.env.GAMES_DATABASE_NAME ?? 'postgres';
  if (!host || !port || !user || !password) {
    throw new Error(
      'Games DB not configured. Set GAMES_DATABASE_URL or all of ' +
        'GAMES_DATABASE_HOST / GAMES_DATABASE_PORT / GAMES_DATABASE_USER / GAMES_DATABASE_PASSWORD.',
    );
  }
  cachedGamesDb = postgres({
    host,
    port: parseInt(port, 10),
    database,
    username: user,
    password,
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
