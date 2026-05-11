export const brand = {
  name: 'Chessco',
  domain: 'chessco.org',
  slogan: 'Scout. Prepare. Win.',
  description:
    'Scout any chess opponent, find their leaks, and practice the exact positions that win the game.',
  loop: ['Scout', 'Find', 'Practice', 'Pay', 'Improve'] as const,
} as const;

/**
 * Design tokens for the Chessco brand.
 *
 * Mirrors the CSS variables defined in apps/web/app/globals.css.
 * Values are kept here so non-CSS consumers (PDFs, emails, OG images,
 * embed widgets) can pull from the same source of truth.
 */
export const tokens = {
  colors: {
    background: 'hsl(222 47% 5%)',
    foreground: 'hsl(210 40% 98%)',
    card: 'hsl(222 47% 8%)',
    primary: 'hsl(222 47% 11%)',
    accent: 'hsl(47 96% 53%)',
    muted: 'hsl(217 33% 17%)',
    border: 'hsl(217 33% 17%)',
    destructive: 'hsl(0 84% 60%)',
  },
  radius: '0.5rem',
  fonts: {
    sans: 'Inter, system-ui, sans-serif',
    display: 'Geist Sans, Inter, system-ui, sans-serif',
    mono: 'Geist Mono, ui-monospace, monospace',
  },
} as const;

export type BrandTokens = typeof tokens;
