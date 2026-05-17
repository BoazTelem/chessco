import { redirect } from 'next/navigation';
import { getUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// /inbox is the landing hub. Two sub-routes today: notifications (system
// events, the new default) and invitations (pending sparring challenges).
// Default to notifications since it covers a strict superset of inbox
// activity; users can navigate to invitations from the header on either page.
export default async function InboxPage() {
  const user = await getUser();
  if (!user) redirect('/login?next=/inbox');
  redirect('/inbox/notifications');
}
