'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { createClient } from '@/lib/supabase/client';
import { updateProfile } from './actions';

const CHESS_TITLES = ['', 'GM', 'IM', 'FM', 'CM', 'NM', 'WGM', 'WIM', 'WFM', 'WCM', 'WNM'] as const;

type ChessTitle = (typeof CHESS_TITLES)[number];

const VISIBILITY_OPTIONS = [
  {
    value: 'public' as const,
    label: 'Public',
    description:
      'Your profile page is visible to anyone, including your linked accounts and games.',
  },
  {
    value: 'private' as const,
    label: 'Private',
    description: 'Only your username is visible. Linked accounts and games stay hidden.',
  },
];

type Initial = {
  display_name: string | null;
  bio: string | null;
  country: string | null;
  chess_title: string | null;
  profile_visibility: 'public' | 'private' | 'coach_public_player_private';
  avatar_url: string | null;
};

type OauthDefaults = {
  display_name: string | null;
  avatar_url: string | null;
};

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

export function ProfileEditForm({
  userId,
  username,
  initial,
  oauthDefaults,
}: {
  userId: string;
  username: string;
  initial: Initial;
  oauthDefaults: OauthDefaults;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [displayName, setDisplayName] = useState(initial.display_name ?? '');
  const [bio, setBio] = useState(initial.bio ?? '');
  const [country, setCountry] = useState((initial.country ?? '').toUpperCase());
  const [chessTitle, setChessTitle] = useState<ChessTitle>(
    (initial.chess_title as ChessTitle | null) ?? '',
  );
  // visibility is null until the user explicitly picks a radio. Submitting
  // null tells the server action to leave the current visibility untouched —
  // important for coach_public_player_private users who would otherwise be
  // silently broadened to public on any save.
  const [visibility, setVisibility] = useState<'public' | 'private' | null>(
    initial.profile_visibility === 'public' || initial.profile_visibility === 'private'
      ? initial.profile_visibility
      : null,
  );
  const isCoachVisibility = initial.profile_visibility === 'coach_public_player_private';
  const [avatarUrl, setAvatarUrl] = useState(initial.avatar_url ?? '');

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  const oauthHasDisplayName =
    oauthDefaults.display_name && oauthDefaults.display_name !== displayName;
  const oauthHasAvatar = oauthDefaults.avatar_url && oauthDefaults.avatar_url !== avatarUrl;

  async function onAvatarChange(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);

    if (file.size > MAX_AVATAR_BYTES) {
      setUploadError('Image is over 5 MB. Pick a smaller file.');
      return;
    }
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      setUploadError('Use a JPEG, PNG, or WebP image.');
      return;
    }

    setUploading(true);
    try {
      const supabase = createClient();
      const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : 'jpg';
      // Cache-bust on each upload so the new image shows immediately even
      // though the storage path stays stable.
      const path = `${userId}/avatar.${ext}`;
      const { error } = await supabase.storage.from('avatars').upload(path, file, {
        upsert: true,
        contentType: file.type,
        cacheControl: '3600',
      });
      if (error) {
        setUploadError(error.message);
        setUploading(false);
        return;
      }
      const { data } = supabase.storage.from('avatars').getPublicUrl(path);
      // Add a cache-buster so the browser fetches the new image.
      setAvatarUrl(`${data.publicUrl}?t=${Date.now()}`);
    } catch (err) {
      setUploadError((err as Error).message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  function pullFromGoogle(): void {
    if (oauthDefaults.display_name) setDisplayName(oauthDefaults.display_name);
    if (oauthDefaults.avatar_url) setAvatarUrl(oauthDefaults.avatar_url);
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (pending) return;
    setFormError(null);
    setSavedFlash(false);

    startTransition(async () => {
      const result = await updateProfile({
        display_name: displayName.trim() || null,
        bio: bio.trim() || null,
        country: country.trim() || null,
        chess_title: chessTitle || null,
        // null means "leave visibility unchanged" — see the comment on the
        // visibility useState above.
        profile_visibility: visibility,
        avatar_url: avatarUrl.trim() || null,
      });
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      setSavedFlash(true);
      router.refresh();
    });
  }

  const canPullFromGoogle = oauthHasDisplayName || oauthHasAvatar;

  return (
    <form onSubmit={onSubmit} className="space-y-8">
      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Avatar
        </h2>
        <div className="mt-4 flex items-start gap-5">
          <AvatarPreview src={avatarUrl} />
          <div className="flex-1 space-y-2">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-muted">
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={onAvatarChange}
                disabled={uploading || pending}
              />
              {uploading ? 'Uploading…' : avatarUrl ? 'Replace' : 'Upload image'}
            </label>
            {avatarUrl && (
              <button
                type="button"
                onClick={() => setAvatarUrl('')}
                className="ml-2 text-xs text-muted-foreground hover:text-foreground"
                disabled={uploading || pending}
              >
                Remove
              </button>
            )}
            <p className="text-xs text-muted-foreground">JPEG, PNG or WebP. Up to 5 MB.</p>
            {uploadError && <p className="text-xs text-destructive">{uploadError}</p>}
          </div>
        </div>
      </section>

      {canPullFromGoogle && (
        <section className="rounded-lg border border-accent/30 bg-accent/5 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold">Use details from your Google account?</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {oauthHasDisplayName && oauthHasAvatar
                  ? 'Pulls your Google name and picture into the form.'
                  : oauthHasDisplayName
                    ? 'Pulls your Google name into the form.'
                    : 'Pulls your Google profile picture into the form.'}
              </p>
            </div>
            <button
              type="button"
              onClick={pullFromGoogle}
              disabled={pending}
              className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground hover:opacity-90 disabled:opacity-60"
            >
              Pull from Google
            </button>
          </div>
        </section>
      )}

      <section className="space-y-5 rounded-lg border border-border bg-card p-5">
        <FieldRow label="Username" hint="Set during signup. Cannot be changed.">
          <input
            type="text"
            readOnly
            value={username}
            className="w-full cursor-not-allowed rounded-md border border-border bg-background px-3 py-1.5 text-sm text-muted-foreground"
          />
        </FieldRow>

        <FieldRow label="Display name" hint="Shown on prep reports, challenges, and leaderboards.">
          <input
            type="text"
            maxLength={80}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g. Magnus Carlsen"
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
            disabled={pending}
          />
        </FieldRow>

        <FieldRow label="Bio" hint="A line or two about your chess. Optional.">
          <textarea
            rows={3}
            maxLength={280}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder="e.g. Improving rapid player, love sharp openings."
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
            disabled={pending}
          />
          <p className="mt-1 text-[11px] text-muted-foreground">{bio.length} / 280</p>
        </FieldRow>

        <div className="grid gap-5 md:grid-cols-2">
          <FieldRow label="Country" hint="ISO code, e.g. US, IL, GB. Optional.">
            <input
              type="text"
              maxLength={2}
              value={country}
              onChange={(e) => setCountry(e.target.value.toUpperCase())}
              placeholder="US"
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm uppercase"
              disabled={pending}
            />
          </FieldRow>

          <FieldRow label="Chess title" hint="If you hold a FIDE title.">
            <select
              value={chessTitle}
              onChange={(e) => setChessTitle(e.target.value as ChessTitle)}
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
              disabled={pending}
            >
              {CHESS_TITLES.map((t) => (
                <option key={t} value={t}>
                  {t === '' ? '— None —' : t}
                </option>
              ))}
            </select>
          </FieldRow>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Profile visibility
        </h2>
        {isCoachVisibility && (
          <p className="mt-3 rounded-md border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-foreground">
            Your profile uses coach-mode visibility (public coach view, private player view). Pick a
            different option below to change it; leave both unselected to keep coach mode.
          </p>
        )}
        <div className="mt-4 space-y-2">
          {VISIBILITY_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition ${
                visibility === opt.value
                  ? 'border-accent bg-accent/5'
                  : 'border-border hover:bg-muted/40'
              }`}
            >
              <input
                type="radio"
                name="profile_visibility"
                value={opt.value}
                checked={visibility === opt.value}
                onChange={() => setVisibility(opt.value)}
                className="mt-0.5 h-4 w-4"
                disabled={pending}
              />
              <span>
                <span className="block text-sm font-medium text-foreground">{opt.label}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {opt.description}
                </span>
              </span>
            </label>
          ))}
          {!isCoachVisibility && (
            <p className="text-[11px] text-muted-foreground">
              Coach-specific visibility is coming with the coach plan.
            </p>
          )}
        </div>
      </section>

      {formError && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {formError}
        </p>
      )}

      {savedFlash && (
        <p className="rounded-md border border-accent/30 bg-accent/5 px-3 py-2 text-sm text-foreground">
          Changes saved.
        </p>
      )}

      <div className="flex items-center justify-between">
        <a
          href="/account"
          className="text-sm text-muted-foreground hover:text-foreground"
          aria-disabled={pending}
        >
          Cancel
        </a>
        <button
          type="submit"
          disabled={pending || uploading}
          className="rounded-md bg-accent px-5 py-2 text-sm font-semibold text-accent-foreground hover:opacity-90 disabled:opacity-60"
        >
          {pending ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}

function FieldRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-foreground">{label}</label>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function AvatarPreview({ src }: { src: string }) {
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={src}
        alt="Avatar preview"
        className="h-20 w-20 shrink-0 rounded-full object-cover ring-1 ring-border"
      />
    );
  }
  return (
    <span
      aria-hidden
      className="grid h-20 w-20 shrink-0 place-items-center rounded-full bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground ring-1 ring-border"
    >
      No image
    </span>
  );
}
