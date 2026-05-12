import { createClient } from '@supabase/supabase-js';

/**
 * Service-role Supabase client — bypasses RLS. Use ONLY in trusted server
 * code (route handlers, server actions) where the action is on behalf of
 * a request the server already validated (e.g. an anonymous /api/identify
 * call where we still want to write a row).
 *
 * Never expose the service role key to the client.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
