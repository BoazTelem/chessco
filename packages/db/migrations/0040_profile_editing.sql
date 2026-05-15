-- ============================================================================
-- Migration: 0040_profile_editing
--
-- Adds the infrastructure for user-editable profiles:
--
--   1. An "avatars" Supabase Storage bucket with row-level policies that let
--      each user upload/replace/delete files at a path keyed on their
--      profile id (e.g. "<uuid>/avatar.jpg") while keeping read access
--      public so the URL written to profiles.avatar_url works without
--      signed-URL plumbing. 5 MB cap; jpeg/png/webp only.
--
--   2. An updated handle_new_user() trigger that, on first sign-in, copies
--      whatever the OAuth provider returned in raw_user_meta_data into the
--      profile row — specifically display_name (from full_name / name) and
--      avatar_url (from avatar_url / picture). This pre-fills the edit form
--      for Google sign-in users instead of leaving them with a blank
--      profile.
-- ============================================================================

-- ----- avatars storage bucket -----

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'avatars',
  'avatars',
  true,
  5242880, -- 5 MB
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Public read so a plain <img src="…/avatars/<uid>/avatar.jpg" /> works.
DROP POLICY IF EXISTS "Avatars are publicly readable" ON storage.objects;
CREATE POLICY "Avatars are publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'avatars');

-- Insert / update / delete restricted to the owning user. The path
-- convention "<auth.uid>/<anything>" gates writes by directory.
DROP POLICY IF EXISTS "Users can upload their own avatar" ON storage.objects;
CREATE POLICY "Users can upload their own avatar"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'avatars'
    AND auth.uid() IS NOT NULL
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "Users can update their own avatar" ON storage.objects;
CREATE POLICY "Users can update their own avatar"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'avatars'
    AND auth.uid() IS NOT NULL
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "Users can delete their own avatar" ON storage.objects;
CREATE POLICY "Users can delete their own avatar"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'avatars'
    AND auth.uid() IS NOT NULL
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- ----- handle_new_user: pre-fill from OAuth metadata -----

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  meta jsonb := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
  meta_display_name text;
  meta_avatar_url text;
BEGIN
  -- Google sends 'full_name' (Supabase normalised) and 'name' (raw OAuth).
  -- Fall back to either before giving up.
  meta_display_name := NULLIF(TRIM(meta->>'full_name'), '');
  IF meta_display_name IS NULL THEN
    meta_display_name := NULLIF(TRIM(meta->>'name'), '');
  END IF;

  -- 'avatar_url' is Supabase's normalised key; 'picture' is the raw OAuth
  -- field. Either is fine — we store whichever we got.
  meta_avatar_url := NULLIF(TRIM(meta->>'avatar_url'), '');
  IF meta_avatar_url IS NULL THEN
    meta_avatar_url := NULLIF(TRIM(meta->>'picture'), '');
  END IF;

  INSERT INTO profiles (id, email, referral_code, display_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    lower(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
    meta_display_name,
    meta_avatar_url
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO wallets (profile_id)
  VALUES (NEW.id)
  ON CONFLICT (profile_id) DO NOTHING;

  INSERT INTO ratings (profile_id)
  VALUES (NEW.id)
  ON CONFLICT (profile_id) DO NOTHING;

  RETURN NEW;
END;
$$;
