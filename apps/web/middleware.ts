import { type NextRequest } from 'next/server';
import { updateSession } from './lib/supabase/middleware';

const SEARCH_SESSION_COOKIE = 'search_session_id';
const THIRTY_DAYS_SEC = 30 * 24 * 60 * 60;

export async function middleware(request: NextRequest) {
  // Issue a long-lived session correlation cookie on first request. Used by
  // apps/web/lib/search-events/log.ts to thread a visitor's events through the
  // /admin/super/searches audit feed (especially anon → signed-in transitions).
  let newSessionId: string | null = null;
  if (!request.cookies.get(SEARCH_SESSION_COOKIE)) {
    newSessionId = crypto.randomUUID();
    // Set on request.cookies first so this same request's server components
    // can read it via `cookies()` and stamp it on any event they log.
    request.cookies.set(SEARCH_SESSION_COOKIE, newSessionId);
  }

  const response = await updateSession(request);

  if (newSessionId) {
    response.cookies.set(SEARCH_SESSION_COOKIE, newSessionId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: THIRTY_DAYS_SEC,
      path: '/',
    });
  }
  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico, *.png, *.svg, *.jpg, etc.
     * - The Supabase OAuth callback (handled by its own route handler)
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
