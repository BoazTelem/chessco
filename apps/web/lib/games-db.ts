/**
 * Google Cloud SQL connection from the web app — for querying
 * games-corpus tables (style_features, handles) at request time.
 *
 * Mirror of apps/workers/src/db.ts:getGamesDb() — duplicated rather
 * than cross-app imported to keep the web app build self-contained.
 */
import postgres from 'postgres';

let cached: ReturnType<typeof postgres> | null = null;

export function getGamesDb(): ReturnType<typeof postgres> {
  if (cached) return cached;

  const sslmode = process.env.GAMES_DATABASE_SSLMODE ?? 'require';
  const ssl = sslmode === 'disable' ? false : { rejectUnauthorized: false };

  const host = process.env.GAMES_DATABASE_HOST;
  const port = process.env.GAMES_DATABASE_PORT;
  const user = process.env.GAMES_DATABASE_USER;
  const password = process.env.GAMES_DATABASE_PASSWORD;
  const database = process.env.GAMES_DATABASE_NAME ?? 'postgres';

  if (!host || !port || !user || !password) {
    throw new Error(
      'Games DB connection not configured. Set GAMES_DATABASE_HOST/PORT/USER/PASSWORD on the web env.',
    );
  }

  cached = postgres({
    host,
    port: parseInt(port, 10),
    database,
    username: user,
    password,
    max: 2, // serverless: tight per-instance ceiling
    idle_timeout: 30,
    connect_timeout: 15,
    prepare: false,
    ssl,
  });
  return cached;
}
