/**
 * Direct Postgres connections for workers.
 *
 * Two databases:
 *  - getDb()       → Supabase (federation_players, players, identifications, …)
 *  - getGamesDb()  → Google Cloud SQL chessco-games (games, moves, style_features, …)
 *
 * Both accept either DATABASE_URL or DATABASE_HOST/PORT/USER/PASSWORD/NAME envs
 * (GAMES_-prefixed for the games DB). The split-env path avoids URL-encoding
 * gotchas when the password contains URL-reserved characters.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { schema } from '@chessco/db';

export function getDb() {
  const url = process.env.DATABASE_URL;
  const passwordOverride = process.env.DATABASE_PASSWORD;

  let client: ReturnType<typeof postgres>;

  if (url) {
    // If a password override is provided, parse the URL and merge.
    if (passwordOverride) {
      const parsed = new URL(url);
      client = postgres({
        host: parsed.hostname,
        port: parsed.port ? parseInt(parsed.port, 10) : 5432,
        database: parsed.pathname.replace(/^\//, '') || 'postgres',
        username: decodeURIComponent(parsed.username),
        password: passwordOverride,
        max: 4,
        idle_timeout: 30,
        connect_timeout: 15,
        prepare: false,
      });
    } else {
      client = postgres(url, {
        max: 4,
        idle_timeout: 30,
        connect_timeout: 15,
        prepare: false,
      });
    }
  } else {
    const host = process.env.DATABASE_HOST;
    const port = process.env.DATABASE_PORT;
    const user = process.env.DATABASE_USER;
    const password = process.env.DATABASE_PASSWORD;
    const database = process.env.DATABASE_NAME ?? 'postgres';
    if (!host || !port || !user || !password) {
      throw new Error(
        'Database connection not configured. Set DATABASE_URL, or all of DATABASE_HOST / DATABASE_PORT / DATABASE_USER / DATABASE_PASSWORD.',
      );
    }
    client = postgres({
      host,
      port: parseInt(port, 10),
      database,
      username: user,
      password,
      max: 4,
      idle_timeout: 30,
      connect_timeout: 15,
      prepare: false,
    });
  }

  return { db: drizzle(client, { schema }), client };
}

export function getGamesDb() {
  const url = process.env.GAMES_DATABASE_URL;
  const sslmode = process.env.GAMES_DATABASE_SSLMODE ?? 'require';
  const ssl = sslmode === 'disable' ? false : { rejectUnauthorized: false };

  let client: ReturnType<typeof postgres>;

  if (url) {
    client = postgres(url, {
      max: 4,
      idle_timeout: 30,
      connect_timeout: 15,
      prepare: false,
      ssl,
    });
  } else {
    const host = process.env.GAMES_DATABASE_HOST;
    const port = process.env.GAMES_DATABASE_PORT;
    const user = process.env.GAMES_DATABASE_USER;
    const password = process.env.GAMES_DATABASE_PASSWORD;
    const database = process.env.GAMES_DATABASE_NAME ?? 'postgres';
    if (!host || !port || !user || !password) {
      throw new Error(
        'Games DB connection not configured. Set GAMES_DATABASE_URL, or all of GAMES_DATABASE_HOST / GAMES_DATABASE_PORT / GAMES_DATABASE_USER / GAMES_DATABASE_PASSWORD.',
      );
    }
    client = postgres({
      host,
      port: parseInt(port, 10),
      database,
      username: user,
      password,
      max: 4,
      idle_timeout: 30,
      connect_timeout: 15,
      prepare: false,
      ssl,
    });
  }

  return { db: drizzle(client), client };
}
