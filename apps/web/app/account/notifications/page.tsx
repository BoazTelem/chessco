import type { Metadata } from 'next';
import Link from 'next/link';
import { requireUser } from '@/lib/auth';
import { getPracticeDb } from '@/lib/practice/db';
import { PrefsForm } from './prefs-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Notification preferences · Chessco',
  robots: { index: false, follow: false },
};

interface PrefRow {
  moderation_email: boolean;
  credits_email: boolean;
  social_email: boolean;
}

async function loadPrefs(userId: string): Promise<PrefRow> {
  const sql = getPracticeDb();
  const rows = (await sql`
    SELECT moderation_email, credits_email, social_email
    FROM notification_email_preferences
    WHERE profile_id = ${userId}::uuid
  `) as PrefRow[];
  return (
    rows[0] ?? {
      moderation_email: true,
      credits_email: true,
      social_email: true,
    }
  );
}

export default async function NotificationPreferencesPage() {
  const user = await requireUser();
  const prefs = await loadPrefs(user.id);

  return (
    <div className="container mx-auto max-w-2xl space-y-6 px-4 py-12">
      <header className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">Account</p>
        <h1 className="font-display text-3xl font-bold tracking-tight">Notifications</h1>
        <p className="text-sm text-muted-foreground">
          Pick which categories of events email you. In-app notifications (the bell) are always on.
          You can&apos;t opt out of being told you were banned.
        </p>
        <p className="text-xs text-muted-foreground">
          <Link href="/account" className="hover:underline">
            ← Back to account
          </Link>
          {' · '}
          <Link href="/inbox/notifications" className="hover:underline">
            See your notifications →
          </Link>
        </p>
      </header>

      <PrefsForm initial={prefs} />
    </div>
  );
}
