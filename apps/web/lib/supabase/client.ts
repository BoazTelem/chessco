'use client';

import { createBrowserClient } from '@supabase/ssr';

/**
 * Browser-side Supabase client for use in Client Components.
 * Uses the public anon key — RLS enforces what the user can read/write.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
