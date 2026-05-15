'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';

const CHESS_TITLES = ['', 'GM', 'IM', 'FM', 'CM', 'NM', 'WGM', 'WIM', 'WFM', 'WCM', 'WNM'] as const;

const COUNTRY_RE = /^[A-Za-z]{2}$/;

const ProfileUpdate = z.object({
  display_name: z.string().trim().min(0).max(80).nullable(),
  bio: z.string().trim().max(280).nullable(),
  country: z
    .string()
    .trim()
    .refine((v) => v === '' || COUNTRY_RE.test(v), 'Country must be a 2-letter code')
    .nullable(),
  chess_title: z.enum(CHESS_TITLES).nullable(),
  // null = leave the existing visibility untouched. This is what lets users
  // on `coach_public_player_private` save other fields without being silently
  // broadened to plain `public` — the form sends null until the user picks a
  // radio.
  profile_visibility: z.enum(['public', 'private']).nullable(),
  // Untrusted URL. Validated against an allowlist (own storage bucket path
  // or OAuth metadata value) inside the action — do not trust the raw value
  // even after Zod accepts it.
  avatar_url: z.string().trim().max(500).nullable(),
});

export type ProfileUpdateInput = z.infer<typeof ProfileUpdate>;

export type ProfileUpdateResult =
  | { ok: true }
  | { ok: false; error: string; fieldErrors?: Partial<Record<keyof ProfileUpdateInput, string>> };

/**
 * Update the signed-in user's editable profile fields. Username is
 * deliberately not editable here — it was claimed during onboarding and
 * changing it breaks every existing /u/<username> link.
 */
export async function updateProfile(input: ProfileUpdateInput): Promise<ProfileUpdateResult> {
  const user = await requireUser();

  const parsed = ProfileUpdate.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: issue?.message ?? 'Invalid input',
      fieldErrors: issue?.path[0]
        ? { [issue.path[0] as keyof ProfileUpdateInput]: issue.message }
        : undefined,
    };
  }
  const data = parsed.data;

  // Empty-string → null so the column reads as "unset" rather than blank.
  const display_name = nullableOrTrimmedNull(data.display_name);
  const bio = nullableOrTrimmedNull(data.bio);
  // ISO codes are conventionally uppercase. The form already uppercases on
  // input but normalise here too so direct API callers can't lowercase us.
  const country = data.country && data.country.length === 2 ? data.country.toUpperCase() : null;
  const chess_title = data.chess_title === '' ? null : data.chess_title;

  // Avatar allowlist: empty → unset, OR a URL inside this user's own folder
  // in the avatars storage bucket, OR an exact match against an avatar URL
  // present in their OAuth metadata. Anything else is rejected so the
  // profile can't be made to embed an arbitrary remote image.
  const rawAvatar = nullableOrTrimmedNull(data.avatar_url);
  const ownStoragePrefix = ownAvatarStoragePrefix(user.id);
  const oauthAvatarUrls = oauthAvatarUrlsFor(user.user_metadata);
  let avatar_url: string | null = null;
  if (rawAvatar !== null) {
    const allowed =
      (ownStoragePrefix !== null && rawAvatar.startsWith(ownStoragePrefix)) ||
      oauthAvatarUrls.has(rawAvatar) ||
      oauthAvatarUrls.has(stripQueryHash(rawAvatar));
    if (!allowed) {
      return {
        ok: false,
        error:
          'Avatar URL must come from your own upload or your Google account. Use the Upload button.',
        fieldErrors: { avatar_url: 'Disallowed avatar URL' },
      };
    }
    avatar_url = rawAvatar;
  }

  // Build the patch. Visibility is omitted when the form sent null so the
  // current value (including coach_public_player_private) is preserved.
  const patch: Record<string, unknown> = {
    display_name,
    bio,
    country,
    chess_title,
    avatar_url,
  };
  if (data.profile_visibility !== null) {
    patch.profile_visibility = data.profile_visibility;
  }

  const supabase = await createClient();
  const { error } = await supabase.from('profiles').update(patch).eq('id', user.id);

  if (error) {
    console.error('[updateProfile] supabase error', error);
    return { ok: false, error: 'Could not save changes. Try again.' };
  }

  revalidatePath('/account');
  revalidatePath('/account/edit');
  return { ok: true };
}

function nullableOrTrimmedNull(s: string | null | undefined): string | null {
  if (s == null) return null;
  const trimmed = s.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Build the public-URL prefix this user is allowed to use for an avatar:
 * `https://<project>.supabase.co/storage/v1/object/public/avatars/<uid>/`
 * Returns null if NEXT_PUBLIC_SUPABASE_URL is not configured (in which case
 * uploads aren't possible anyway, and we reject any avatar_url).
 */
function ownAvatarStoragePrefix(userId: string): string | null {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/storage/v1/object/public/avatars/${userId}/`;
}

/**
 * Extract avatar URL values from Supabase Auth user_metadata so a user can
 * keep their Google profile picture. Both Supabase's normalised key
 * `avatar_url` and the raw OAuth `picture` field are accepted.
 */
function oauthAvatarUrlsFor(meta: unknown): Set<string> {
  const out = new Set<string>();
  if (!meta || typeof meta !== 'object') return out;
  const m = meta as Record<string, unknown>;
  for (const k of ['avatar_url', 'picture'] as const) {
    const v = m[k];
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed.length > 0) out.add(trimmed);
    }
  }
  return out;
}

/**
 * Cache-busting suffixes (?t=12345) get appended client-side after upload.
 * Strip them when comparing against the OAuth allowlist so the user can
 * still pull their Google avatar even after we tack on a query string.
 */
function stripQueryHash(url: string): string {
  const q = url.indexOf('?');
  const h = url.indexOf('#');
  let cut = url.length;
  if (q >= 0) cut = Math.min(cut, q);
  if (h >= 0) cut = Math.min(cut, h);
  return url.slice(0, cut);
}

/**
 * Redirect helper used by the form's `cancel` button so the route handler
 * can decide where to send the user back to.
 */
export async function cancelEdit(): Promise<void> {
  redirect('/account');
}
