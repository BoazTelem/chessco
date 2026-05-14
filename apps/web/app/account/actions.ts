'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import {
  LICHESS_CLIENT_ID,
  LICHESS_OAUTH_AUTHORIZE_URL,
  codeChallenge,
  randomToken,
} from '@/lib/lichess';
import {
  chesscomRatings,
  fetchChesscomPlayer,
  fetchChesscomStats,
  profileContainsToken,
} from '@/lib/chesscom';
import { grantLinkCredits } from '@/lib/credits';
import { sendEvent } from '@/lib/inngest';

const LICHESS_COOKIE = 'chessco_lichess_oauth';
const COOKIE_TTL_SECONDS = 10 * 60;

async function getRequestOrigin(): Promise<string> {
  const h = await headers();
  const proto = h.get('x-forwarded-proto') ?? 'https';
  const host =
    h.get('host') ?? new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'https://chessco.org').host;
  return `${proto}://${host}`;
}

// ============================================================================
// LICHESS OAUTH — PKCE flow (no client secret)
// ============================================================================

/**
 * Generate state + PKCE verifier, stash in a short-lived httpOnly cookie,
 * then redirect the browser to Lichess's consent screen.
 *
 * Lichess returns to `/auth/lichess/callback` with `?code=...&state=...`.
 */
export async function startLichessLink() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = codeChallenge(verifier);
  const origin = await getRequestOrigin();
  const redirectUri = `${origin}/auth/lichess/callback`;

  const cookieStore = await cookies();
  cookieStore.set(LICHESS_COOKIE, JSON.stringify({ state, verifier }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_TTL_SECONDS,
  });

  const authorizeUrl = new URL(LICHESS_OAUTH_AUTHORIZE_URL);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', LICHESS_CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('state', state);
  // We don't request any scopes — the public /api/account endpoint returns
  // username + ratings without scopes for the authenticated user.

  redirect(authorizeUrl.toString());
}

// ============================================================================
// CHESS.COM — bio-token verification (no OAuth available)
// ============================================================================

export type ChesscomIssueResult =
  | {
      ok: true;
      token: string;
      handle: string;
      profileUrl: string;
      expiresAt: string;
    }
  | { ok: false; error: string };

/**
 * Issue a one-time verification token for a chess.com handle. The user pastes
 * the token into their chess.com profile location field, then clicks Verify.
 */
export async function issueChesscomToken(formData: FormData): Promise<ChesscomIssueResult> {
  const handle = String(formData.get('handle') ?? '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '');
  if (!/^[a-z0-9_-]{2,30}$/.test(handle)) {
    return { ok: false, error: 'Enter a valid Chess.com username.' };
  }

  // Confirm the handle exists on chess.com before issuing.
  try {
    await fetchChesscomPlayer(handle);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  // Token format: `chessco-XXXXXXXX` — short enough to fit in chess.com's
  // location field (limited to ~30 chars), unique enough to not false-match.
  const token = `chessco-${randomToken(6).slice(0, 8).toLowerCase()}`;
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min

  // Invalidate prior chess.com tokens for this user.
  await supabase
    .from('verification_tokens')
    .update({ consumed: true })
    .eq('profile_id', user.id)
    .eq('platform', 'chess.com')
    .eq('consumed', false);

  const { error } = await supabase.from('verification_tokens').insert({
    profile_id: user.id,
    platform: 'chess.com',
    token,
    consumed: false,
    expires_at: expiresAt.toISOString(),
  });
  if (error) return { ok: false, error: error.message };

  // Stash the handle in metadata so verify() knows which account to recheck.
  await supabase.auth.updateUser({
    data: { chesscom_pending_handle: handle },
  });

  return {
    ok: true,
    token,
    handle,
    profileUrl: `https://www.chess.com/member/${handle}`,
    expiresAt: expiresAt.toISOString(),
  };
}

export type ChesscomVerifyResult = { ok: true } | { ok: false; error: string };

export async function verifyChesscomToken(): Promise<ChesscomVerifyResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const handle =
    typeof user.user_metadata?.chesscom_pending_handle === 'string'
      ? user.user_metadata.chesscom_pending_handle
      : null;
  if (!handle) {
    return {
      ok: false,
      error: 'No pending chess.com link found. Please start over.',
    };
  }

  const { data: tokenRow } = await supabase
    .from('verification_tokens')
    .select('token, expires_at')
    .eq('profile_id', user.id)
    .eq('platform', 'chess.com')
    .eq('consumed', false)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!tokenRow) {
    return { ok: false, error: 'No active verification token. Issue a new one.' };
  }
  if (new Date(tokenRow.expires_at) < new Date()) {
    return { ok: false, error: 'Token expired. Issue a new one.' };
  }

  let player;
  try {
    player = await fetchChesscomPlayer(handle);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (!profileContainsToken(player, tokenRow.token)) {
    return {
      ok: false,
      error: `Token "${tokenRow.token}" not found in your chess.com profile. Paste it in the Location field, save, then try again.`,
    };
  }

  // Fetch ratings.
  let ratings = {};
  try {
    const stats = await fetchChesscomStats(handle);
    ratings = chesscomRatings(stats);
  } catch {
    // Stats are best-effort; account link succeeds even if stats fail.
  }

  // Upsert external_accounts row.
  const { error: upsertErr } = await supabase.from('external_accounts').upsert(
    {
      profile_id: user.id,
      platform: 'chess.com',
      external_id: handle,
      external_url: player.url,
      verified: true,
      last_synced_at: new Date().toISOString(),
      ...ratings,
    },
    { onConflict: 'platform,external_id' },
  );
  if (upsertErr) return { ok: false, error: upsertErr.message };

  try {
    await grantLinkCredits(user.id, 'chess.com', handle);
  } catch (e) {
    console.error('credit grant failed for chess.com link', e);
    return { ok: false, error: 'Account linked, but credit grant failed. Try refreshing.' };
  }

  // Burn the token.
  await supabase
    .from('verification_tokens')
    .update({ consumed: true })
    .eq('profile_id', user.id)
    .eq('platform', 'chess.com')
    .eq('consumed', false);

  // Enqueue the fast-lane fingerprint build so the corpus has this account's
  // style data ready before the W10 "Import your games" surface ships. Sent
  // fire-and-forget — a transient Inngest outage must not break the link flow.
  await sendEvent({
    name: 'chessco/account.linked.chesscom',
    data: {
      profile_id: user.id,
      handle: handle.toLowerCase(),
    },
  });

  return { ok: true };
}

/**
 * Unlink an external account. Used by the "Disconnect" button on /account.
 */
export async function unlinkExternalAccount(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  if (!id) return;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  await supabase.from('external_accounts').delete().eq('id', id).eq('profile_id', user.id);
}
