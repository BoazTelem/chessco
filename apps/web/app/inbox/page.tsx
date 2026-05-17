import { redirect } from 'next/navigation';
import { getUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// /inbox is the landing hub. There's only one section today (invitations);
// when more land (e.g. match reminders, refund updates) this stays the
// shell.
export default async function InboxPage() {
  const user = await getUser();
  if (!user) redirect('/login?next=/inbox');
  redirect('/inbox/invitations');
}
