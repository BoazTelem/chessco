'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { getPracticeDb } from '@/lib/practice/db';

const Input = z.object({
  moderation_email: z.boolean(),
  credits_email: z.boolean(),
  social_email: z.boolean(),
});

export type NotificationPrefs = z.infer<typeof Input>;

export async function setNotificationPrefs(
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = Input.safeParse({
    moderation_email: formData.get('moderation_email') === 'true',
    credits_email: formData.get('credits_email') === 'true',
    social_email: formData.get('social_email') === 'true',
  });
  if (!parsed.success) return { ok: false, error: 'Invalid input.' };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const { moderation_email, credits_email, social_email } = parsed.data;

  const sql = getPracticeDb();
  await sql`
    INSERT INTO notification_email_preferences (
      profile_id, moderation_email, credits_email, social_email, updated_at
    ) VALUES (
      ${user.id}::uuid, ${moderation_email}, ${credits_email}, ${social_email}, NOW()
    )
    ON CONFLICT (profile_id) DO UPDATE SET
      moderation_email = EXCLUDED.moderation_email,
      credits_email = EXCLUDED.credits_email,
      social_email = EXCLUDED.social_email,
      updated_at = NOW()
  `;

  revalidatePath('/account/notifications');
  return { ok: true };
}
