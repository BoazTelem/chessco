'use client';

import { usePathname } from 'next/navigation';
import { SiteFooter } from './footer';

/**
 * Hide the global footer on full-screen Practice game pages, where the board
 * should fill the viewport without product chrome competing for attention.
 */
export function ConditionalFooter() {
  const pathname = usePathname();
  if (pathname?.startsWith('/practice/g/') && !pathname?.endsWith('/review')) return null;
  return <SiteFooter />;
}
