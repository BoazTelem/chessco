import { notFound, redirect } from 'next/navigation';
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

// Returns the authenticated user only if their email matches SUPER_ADMIN_EMAIL.
// Otherwise renders a 404 — we deliberately don't reveal that /admin/super exists.
export async function requireSuperAdmin() {
  const user = await requireUser();
  const expected = process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  const actual = user.email?.trim().toLowerCase();
  if (!expected || !actual || actual !== expected) {
    notFound();
  }
  return user;
}

export function isSuperAdminEmail(email: string | null | undefined): boolean {
  const expected = process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  return !!expected && !!email && email.trim().toLowerCase() === expected;
}
