import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { getPracticeDb } from '@/lib/practice/db';

/**
 * Referral capture route. Stashes the inviter's referral_code in a cookie
 * so /auth/callback can grant the invite credits once the new user verifies
 * their email. Cookie is preferred over user_metadata because it survives
 * uniformly across password signup, magic-link OTP, and Google OAuth.
 *
 * Unknown codes redirect to /signup without setting the cookie — silent
 * fallback rather than user-facing error.
 */

export const REFERRAL_COOKIE = 'chessco_ref';
const REFERRAL_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { origin } = new URL(request.url);
  const { code } = await ctx.params;
  const normalized = code.trim().toLowerCase();

  if (!/^[a-z0-9]{1,32}$/.test(normalized)) {
    return NextResponse.redirect(`${origin}/signup`);
  }

  const sql = getPracticeDb();
  const rows = (await sql`
    SELECT id FROM profiles WHERE referral_code = ${normalized} LIMIT 1
  `) as Array<{ id: string }>;

  if (rows.length === 0) {
    return NextResponse.redirect(`${origin}/signup`);
  }

  const cookieStore = await cookies();
  cookieStore.set(REFERRAL_COOKIE, normalized, {
    maxAge: REFERRAL_COOKIE_MAX_AGE_S,
    sameSite: 'lax',
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
  });

  return NextResponse.redirect(`${origin}/signup?via=ref`);
}
