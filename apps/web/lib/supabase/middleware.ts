import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Session-refresh middleware helper. Called from apps/web/middleware.ts.
 *
 * Reads the session from cookies, optionally refreshes the access token
 * if it's near expiry, and writes the new cookies to the response so the
 * browser stays logged in across requests.
 *
 * Important: do NOT remove the `supabase.auth.getUser()` call below — it
 * is what triggers the refresh.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: Record<string, unknown> }[]) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // Trigger token refresh if needed.
  await supabase.auth.getUser();

  return response;
}
