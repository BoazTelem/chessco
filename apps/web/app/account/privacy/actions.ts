'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';

const Visibility = z.enum(['public', 'private', 'coach_public_player_private']);
export type ProfileVisibility = z.infer<typeof Visibility>;

export async function setProfileVisibility(
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const raw = formData.get('value');
  const parsed = Visibility.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'Invalid visibility option.' };

  // Coach mode requires coach features which haven't shipped; refuse for now.
  if (parsed.data === 'coach_public_player_private') {
    return { ok: false, error: 'Coach visibility is not available yet.' };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const { error } = await supabase
    .from('profiles')
    .update({ profile_visibility: parsed.data })
    .eq('id', user.id);

  if (error) return { ok: false, error: error.message };

  revalidatePath('/account/privacy');
  revalidatePath('/practice');
  if (user.id) revalidatePath(`/u/`);
  return { ok: true };
}
