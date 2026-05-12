import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { OnboardingForm } from './onboarding-form';

export const metadata = {
  title: 'Welcome',
};

export default async function OnboardingPage() {
  const user = await requireUser();
  const supabase = await createClient();
  const { data: profile } = await supabase
    .from('profiles')
    .select('username, display_name, country, date_of_birth, marketing_consent')
    .eq('id', user.id)
    .maybeSingle();

  // If onboarding is already done, skip to dashboard.
  if (profile?.country && profile?.username) {
    redirect('/dashboard');
  }

  return (
    <div className="container mx-auto max-w-xl px-4 py-12">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">Welcome</p>
        <h1 className="font-display text-3xl font-bold tracking-tight">Let&apos;s set you up</h1>
        <p className="text-sm text-muted-foreground">
          Tell us a bit about yourself. You can change any of this later from your account settings.
        </p>
      </div>

      <div className="mt-8">
        <OnboardingForm
          initial={{
            username: profile?.username ?? '',
            displayName: profile?.display_name ?? '',
            country: profile?.country ?? '',
            dateOfBirth: profile?.date_of_birth ?? '',
            marketingConsent: profile?.marketing_consent ?? false,
          }}
        />
      </div>
    </div>
  );
}
