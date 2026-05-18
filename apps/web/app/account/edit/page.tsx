import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { ProfileEditForm } from './profile-edit-form';

export const metadata = {
  title: 'Edit profile',
};

type ProfileRow = {
  username: string | null;
  display_name: string | null;
  bio: string | null;
  country: string | null;
  chess_title: string | null;
  profile_visibility: 'public' | 'private' | 'coach_public_player_private';
  avatar_url: string | null;
};

export default async function EditProfilePage() {
  const user = await requireUser();
  const supabase = await createClient();

  const { data: profile } = (await supabase
    .from('profiles')
    .select('username, display_name, bio, country, chess_title, profile_visibility, avatar_url')
    .eq('id', user.id)
    .maybeSingle()) as { data: ProfileRow | null };

  // If onboarding hasn't run yet (no username) push the user there. The edit
  // form expects a fully-set-up profile to update.
  if (!profile?.username) {
    redirect('/onboarding');
  }

  // OAuth metadata that the user might want to pull in. Google sets
  // full_name / name / picture / avatar_url; we surface whichever exists.
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const oauthDefaults = {
    display_name:
      pickString(meta.full_name) ?? pickString(meta.name) ?? pickString(meta.given_name),
    avatar_url: pickString(meta.avatar_url) ?? pickString(meta.picture),
  };

  return (
    <div className="container mx-auto max-w-2xl space-y-8 px-4 py-12">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">Account</p>
          <h1 className="font-display text-3xl font-bold tracking-tight">Edit profile</h1>
          <p className="text-sm text-muted-foreground">
            Update what other players see when they find you on Chessco.
          </p>
        </div>
        <Link
          href="/account"
          className="rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted"
        >
          Back
        </Link>
      </header>

      <ProfileEditForm
        userId={user.id}
        username={profile.username}
        initial={{
          display_name: profile.display_name,
          bio: profile.bio,
          country: profile.country,
          chess_title: profile.chess_title,
          // Pass the full enum value through; the form preserves coach-style
          // visibility unless the user explicitly picks a different radio.
          profile_visibility: profile.profile_visibility,
          avatar_url: profile.avatar_url,
        }}
        oauthDefaults={oauthDefaults}
      />
    </div>
  );
}

function pickString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}
