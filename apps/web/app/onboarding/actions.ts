'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export type OnboardingResult = { ok: true } | { ok: false; error: string };

export async function completeOnboarding(formData: FormData): Promise<OnboardingResult> {
  const username = String(formData.get('username') ?? '')
    .trim()
    .toLowerCase();
  const displayName = String(formData.get('display_name') ?? '').trim();
  const country = String(formData.get('country') ?? '')
    .trim()
    .toUpperCase();
  const dateOfBirth = String(formData.get('date_of_birth') ?? '');
  const marketingConsent = formData.get('marketing_consent') === 'on';

  if (!/^[a-z0-9_-]{3,30}$/.test(username)) {
    return {
      ok: false,
      error: 'Username must be 3–30 characters, lowercase letters/numbers/underscore/dash only.',
    };
  }
  if (!displayName || displayName.length > 60) {
    return { ok: false, error: 'Display name is required (max 60 characters).' };
  }
  if (!country || country.length !== 2) {
    return { ok: false, error: 'Please choose your country.' };
  }
  if (!dateOfBirth) {
    return { ok: false, error: 'Please enter your date of birth.' };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: 'Not signed in.' };
  }

  // Check username uniqueness (the UNIQUE constraint will also enforce this,
  // but we give a friendlier error here).
  const { data: existing } = await supabase
    .from('profiles')
    .select('id')
    .eq('username', username)
    .neq('id', user.id)
    .maybeSingle();
  if (existing) {
    return { ok: false, error: 'That username is taken. Please try another.' };
  }

  const { error } = await supabase
    .from('profiles')
    .update({
      username,
      display_name: displayName,
      country,
      date_of_birth: dateOfBirth,
      marketing_consent: marketingConsent,
    })
    .eq('id', user.id);

  if (error) {
    return { ok: false, error: error.message };
  }

  redirect('/dashboard');
}
