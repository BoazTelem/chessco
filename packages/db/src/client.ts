/**
 * Server-side Drizzle client for the Chessco Postgres instance (Supabase).
 *
 * IMPORTANT: this module is server-only. It uses `SUPABASE_SERVICE_ROLE_KEY`
 * patterns and a direct postgres-js connection that bypasses RLS. Never
 * import it from a Client Component. Use the Supabase JS client with the
 * anon key for user-scoped queries from the browser.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

declare global {
  // Reuse a single connection pool across hot reloads in dev.
  // eslint-disable-next-line no-var
  var __chesscoPgPool: ReturnType<typeof postgres> | undefined;
}

function getConnectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Add it to apps/web/.env.local — see docs/SETUP.md.');
  }
  return url;
}

function getPool(): ReturnType<typeof postgres> {
  if (!globalThis.__chesscoPgPool) {
    globalThis.__chesscoPgPool = postgres(getConnectionString(), {
      // Supabase's pooler caps at 15 connections by default on free/pro.
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false, // required when using Supabase's transaction-mode pooler
    });
  }
  return globalThis.__chesscoPgPool;
}

/**
 * The Drizzle DB instance. Lazily initialized so importing this module in
 * a context without DATABASE_URL (e.g. unit tests) doesn't crash.
 */
let _db: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function db(): ReturnType<typeof drizzle<typeof schema>> {
  if (!_db) {
    _db = drizzle(getPool(), { schema });
  }
  return _db;
}

export { schema };
