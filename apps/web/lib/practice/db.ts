import postgres from 'postgres';

/**
 * Direct Postgres connection to the Supabase main DB for Practice route
 * handlers. We use raw SQL with transactions for wallet/ledger writes that
 * must be atomic — the supabase-js client doesn't expose transactions.
 *
 * Uses the service role connection string (bypasses RLS by virtue of
 * connecting as postgres). All routes that touch this client MUST do
 * their own auth + authorization checks first.
 */

let cached: ReturnType<typeof postgres> | null = null;

export function getPracticeDb(): ReturnType<typeof postgres> {
  if (cached) return cached;
  const url = process.env.PRACTICE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('PRACTICE_DATABASE_URL (or DATABASE_URL) not set');
  }
  cached = postgres(url, {
    max: 5,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false,
  });
  return cached;
}
