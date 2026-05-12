/**
 * Direct Postgres connection for workers — bypasses RLS (postgres role).
 * Used for bulk operations that don't suit the Supabase HTTP client.
 *
 * Accepts either:
 *  - DATABASE_URL (full connection string), or
 *  - DATABASE_HOST + DATABASE_PORT + DATABASE_USER + DATABASE_PASSWORD + DATABASE_NAME
 *
 * The latter avoids URL-encoding gotchas when the password contains
 * URL-reserved characters (e.g. '@', ':', '/').
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
