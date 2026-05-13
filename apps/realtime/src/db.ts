import postgres from 'postgres';
import { env } from './env';

/**
 * Single shared `postgres` connection pool for the realtime server.
 * The realtime app uses raw SQL (not Drizzle) to keep dependencies light
 * and the move-write path as direct as possible.
 *
 * Connections are configured for the Supabase pooler in production;
 * locally they hit the direct port.
 */
export const sql = postgres(env.databaseUrl, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
  prepare: false,
});
