'use client';

import { usePathname } from 'next/navigation';

const HIDE_PREFIXES = ['/admin/super', '/login', '/signup'];

/**
 * Hide the global header on routes that own their chrome (admin, auth),
 * intentionally render fullscreen (live Practice games; the /review subroute
 * keeps chrome), or are designed as a logo-led landing surface (home).
 * Mirrors ConditionalFooter's route-based opt-out.
 */
export function ConditionalSiteHeader({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '';
  if (pathname === '/') return null;
  if (pathname.startsWith('/practice/g/') && !pathname.endsWith('/review')) return null;
  if (HIDE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;
  return <>{children}</>;
}
