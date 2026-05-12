import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import {
  LICHESS_CLIENT_ID,
  LICHESS_OAUTH_TOKEN_URL,
  fetchLichessAccount,
  lichessRatings,
} from '@/lib/lichess';

const LICHESS_COOKIE = 'chessco_lichess_oauth';

/**
 * Handles the redirect from Lichess's OAuth consent screen.
 *
 *  1. Validate state matches the cookie set by `startLichessLink`.
 *  2. Exchange the auth code (+ PKCE verifier) for an access token.
 *  3. Fetch the Lichess /api/account to get the verified username + ratings.
 *  4. Upsert into external_accounts with verified=true.
 *  5. Redirect back to /account with a success/error query param.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const lichessError = searchParams.get('error');

  const back = (qs: string) => NextResponse.redirect(`${origin}/account?${qs}`);

  if (lichessError) {
    return back(`lichess_error=${encodeURIComponent(lichessError)}`);
  }
  if (!code || !state) {
    return back('lichess_error=missing_code_or_state');
  }

  const cookieStore = await cookies();
  const stash = cookieStore.get(LICHESS_COOKIE)?.value;
  cookieStore.delete(LICHESS_COOKIE);

  if (!stash) {
    return back('lichess_error=session_expired');
  }
  let parsed: { state: string; verifier: string };
  try {
    parsed = JSON.parse(stash);
  } catch {
    return back('lichess_error=bad_state');
  }
  if (parsed.state !== state) {
    return back('lichess_error=state_mismatch');
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(`${origin}/login`);
  }

  // Exchange the code for an access token (Lichess uses form-encoded body).
  const tokenRes = await fetch(LICHESS_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${origin}/auth/lichess/callback`,
      client_id: LICHESS_CLIENT_ID,
      code_verifier: parsed.verifier,
    }).toString(),
    cache: 'no-store',
  });
  if (!tokenRes.ok) {
    const detail = await tokenRes.text();
    console.error('Lichess token exchange failed', tokenRes.status, detail);
    return back(`lichess_error=token_exchange_failed`);
  }
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) {
    return back('lichess_error=no_access_token');
  }

  // Fetch the authenticated user's account.
  let account;
  try {
    account = await fetchLichessAccount(tokenJson.access_token);
  } catch (e) {
    console.error('Lichess /account fetch failed', e);
    return back('lichess_error=account_fetch_failed');
  }
  if (!account.username || !account.id) {
    return back('lichess_error=invalid_account');
  }

  const ratings = lichessRatings(account);

  // Best-effort token revocation (Lichess supports DELETE /api/token).
  // Not strictly required since the token is short-lived in our flow.
  fetch(`https://lichess.org/api/token`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokenJson.access_token}` },
  }).catch(() => {});

  // Upsert into external_accounts. The platform+external_id unique constraint
  // means if someone else previously claimed this handle the upsert will
  // collide — we treat that as "already linked elsewhere" and surface a
  // friendly error.
  const externalAccount = {
    profile_id: user.id,
    platform: 'lichess' as const,
    external_id: account.username.toLowerCase(),
    external_url: `https://lichess.org/@/${account.username}`,
    verified: true,
    confidence_score: 1,
    last_synced_at: new Date().toISOString(),
    ...ratings,
  };

  const { error: upsertErr } = await supabase
    .from('external_accounts')
    .upsert(externalAccount, { onConflict: 'platform,external_id' });

  if (upsertErr) {
    console.error('external_accounts upsert failed', upsertErr);
    return back(`lichess_error=${encodeURIComponent('save_failed')}`);
  }

  return back(`linked=lichess&handle=${encodeURIComponent(account.username)}`);
}
