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

/**
 * Comma-separated list of super-admin emails from env. Reads
 * SUPER_ADMIN_EMAILS first, falls back to the legacy single SUPER_ADMIN_EMAIL
 * for back-compat with existing deploys.
 */
function superAdminEmails(): Set<string> {
  const raw = process.env.SUPER_ADMIN_EMAILS ?? process.env.SUPER_ADMIN_EMAIL ?? '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

// Returns the authenticated user only if their email is in SUPER_ADMIN_EMAILS
// (or matches the legacy SUPER_ADMIN_EMAIL). Otherwise renders a 404 — we
// deliberately don't reveal that /admin/super exists.
export async function requireSuperAdmin() {
  const user = await requireUser();
  const allowed = superAdminEmails();
  const actual = user.email?.trim().toLowerCase();
  if (allowed.size === 0 || !actual || !allowed.has(actual)) {
    notFound();
  }
  return user;
}

export function isSuperAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return superAdminEmails().has(email.trim().toLowerCase());
}
