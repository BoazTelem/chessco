import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * Handles the redirect from a Supabase magic-link or OAuth flow.
 *
 * Exchanges the `code` for a session, then sends the user onward:
 *   - new users (no profile.country) → /onboarding
 *   - returning users → /dashboard
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next');

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(error.message)}`);
  }

  // Decide where to send them. If they have completed onboarding (country set),
  // go to dashboard; otherwise route through onboarding.
  const {
    data: { user },
  } = await supabase.auth.getUser();

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
