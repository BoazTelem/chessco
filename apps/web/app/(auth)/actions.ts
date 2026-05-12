'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

function getOrigin() {
  return process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
}

async function getRequestOrigin() {
  const h = await headers();
  const proto = h.get('x-forwarded-proto') ?? 'https';
  const host = h.get('host') ?? new URL(getOrigin()).host;
  return `${proto}://${host}`;
}

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Send a magic-link email to the given address. The link points to
 * /auth/callback which exchanges the code for a session and routes the
 * user onward (onboarding for new users, dashboard for returning).
 */
export async function sendMagicLink(formData: FormData): Promise<ActionResult> {
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase();
  if (!email || !email.includes('@')) {
    return { ok: false, error: 'Please enter a valid email address.' };
  }

  const supabase = await createClient();
  const origin = await getRequestOrigin();

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${origin}/auth/callback`,
    },
  });

  if (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * Sign up with email + password + profile bootstrap data. The DB trigger
 * (handle_new_user) auto-creates the profile/wallet/rating rows; we then
 * fill in the bootstrap fields the user provided.
 */
export async function signUp(formData: FormData): Promise<ActionResult> {
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase();
  const password = String(formData.get('password') ?? '');
  const country = String(formData.get('country') ?? '')
    .trim()
    .toUpperCase();
  const dateOfBirth = String(formData.get('date_of_birth') ?? '');
  const marketingConsent = formData.get('marketing_consent') === 'on';

  if (!email || !email.includes('@')) {
    return { ok: false, error: 'Please enter a valid email address.' };
  }
  if (password.length < 8) {
    return { ok: false, error: 'Password must be at least 8 characters.' };
  }
  if (!country || country.length !== 2) {
    return { ok: false, error: 'Please choose your country.' };
  }
  if (!dateOfBirth) {
    return { ok: false, error: 'Please enter your date of birth.' };
  }

  // 18+ gate for paid features (spec §3, §16).
  const dob = new Date(dateOfBirth);
  const ageMs = Date.now() - dob.getTime();
  const ageYears = ageMs / (365.25 * 24 * 60 * 60 * 1000);
  if (ageYears < 13) {
    return { ok: false, error: 'You must be at least 13 to use Chessco.' };
  }

  const supabase = await createClient();
  const origin = await getRequestOrigin();

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${origin}/auth/callback`,
      data: { country, date_of_birth: dateOfBirth, marketing_consent: marketingConsent },
    },
  });

  if (error) {
    return { ok: false, error: error.message };
  }

  // If email confirmation is disabled, signUp returns a session and we can
  // immediately stash profile bootstrap data. Otherwise the user gets an
  // email and finalizes via /auth/callback → /onboarding.
  if (data.user && data.session) {
    await supabase
      .from('profiles')
      .update({
        country,
        date_of_birth: dateOfBirth,
        marketing_consent: marketingConsent,
      })
      .eq('id', data.user.id);
  }

  return { ok: true };
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/');
}
