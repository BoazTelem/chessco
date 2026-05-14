import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionIdFromJwt } from '@/lib/auth/session-jwt';
import { grantReferralCredits } from '@/lib/credits';
import { REFERRAL_COOKIE } from '@/app/r/[code]/route';

/**
 * Handles the redirect from a Supabase magic-link or OAuth flow.
 *
 * Exchanges the `code` for a session, then sends the user onward:
 *   - new users (no profile.country) → /onboarding
 *   - returning users → /dashboard
 *
 * Also redeems any pending referral cookie set by /r/[code] once the user's
 * email is verified. The grant is best-effort and never blocks the redirect.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next');

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const supabase = await createClient();
  const { data: exchange, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(error.message)}`);
  }

  // Decide where to send them. If they have completed onboarding (country set),
  // go to dashboard; otherwise route through onboarding.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Single-active-session enforcement. Record this login's session_id in
  // user_active_session and revoke every other refresh token for the user.
  // SessionGuard on any older browser tab subscribes to UPDATEs on that row
  // and signs itself out the instant this write lands; revoked refresh
  // tokens are the fallback for tabs that miss the Realtime event.
  const accessToken = exchange.session?.access_token;
  const sessionId = getSessionIdFromJwt(accessToken);
  if (user && sessionId && accessToken) {
    try {
      const admin = createAdminClient();
      await admin
        .from('user_active_session')
        .upsert(
          { user_id: user.id, session_id: sessionId, updated_at: new Date().toISOString() },
          { onConflict: 'user_id' },
        );
      await admin.auth.admin.signOut(accessToken, 'others');
    } catch (err) {
      // Don't block the login on enforcement errors — log and continue.
      console.error('[auth/callback] single-session enforcement failed', err);
    }
  }

  // Redeem a pending referral cookie, if any. Email must be verified — the
  // /auth/callback hit after a magic-link click is itself the verification
  // event, so `email_confirmed_at` is set by this point for new signups.
  const cookieStore = await cookies();
  const referralCode = cookieStore.get(REFERRAL_COOKIE)?.value;
  if (user && referralCode) {
    cookieStore.delete(REFERRAL_COOKIE);
    if (user.email_confirmed_at) {
      try {
        const result = await grantReferralCredits(referralCode, user.id);
        if (result.granted > 0) {
          console.log(
            `[auth/callback] referral credited: code=${referralCode} user=${user.id} amount=${result.granted}`,
          );
        } else {
          console.log(
            `[auth/callback] referral skipped: code=${referralCode} user=${user.id} reason=${result.reason}`,
          );
        }
      } catch (err) {
        console.error('[auth/callback] grantReferralCredits failed', err);
      }
    }
  }

  if (next) {
    return NextResponse.redirect(`${origin}${next}`);
  }

  if (!user) {
    return NextResponse.redirect(`${origin}/login?error=no_user`);
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('country')
    .eq('id', user.id)
    .maybeSingle();

  if (profile?.country) {
    return NextResponse.redirect(`${origin}/dashboard`);
  }
  return NextResponse.redirect(`${origin}/onboarding`);
}
