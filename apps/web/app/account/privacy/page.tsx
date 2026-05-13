import Link from 'next/link';
import { requireUser } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { PrivacyForm } from './privacy-form';

export const metadata = {
  title: 'Privacy',
};

export default async function PrivacyPage() {
  const user = await requireUser();
  const supabase = await createClient();

  const { data: profile } = await supabase
    .from('profiles')
    .select('username, profile_visibility')
    .eq('id', user.id)
    .maybeSingle();

  const current = (profile?.profile_visibility ?? 'public') as
    | 'public'
    | 'private'
    | 'coach_public_player_private';

  return (
    <div className="container mx-auto max-w-2xl space-y-8 px-4 py-12">
      <header className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">Account</p>
        <h1 className="font-display text-3xl font-bold tracking-tight">Privacy</h1>
        <p className="text-sm text-muted-foreground">
          Control whether other people can open your Chessco profile and see your linked accounts
          and Practice games. Free, switchable any time.
        </p>
        <p className="text-xs text-muted-foreground">
          <Link href="/account" className="hover:underline">
            ← Back to account
          </Link>
        </p>
      </header>

      <PrivacyForm initial={current} username={profile?.username ?? null} />
    </div>
  );
}
