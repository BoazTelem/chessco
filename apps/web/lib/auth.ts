import { redirect } from 'next/navigation';
import { createClient } from './supabase/server';

/**
 * Returns the authenticated user, or redirects to /login if not signed in.
 * Use in Server Components for protected pages.
 */
export async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect('/login');
  }

  return user;
}

/**
 * Returns the authenticated user or null. Use when the page renders for
 * both logged-in and logged-out states (e.g. landing page).
 */
export async function getUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}
