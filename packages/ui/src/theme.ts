export const brand = {
  name: 'Chessco',
  domain: 'chessco.org',
  slogan: 'Scout. Prepare. Win.',
  /**
   * Marketplace surfaces (challenge lobby, /challenges/new, /game/*, /account/wallet)
   * must avoid result-conditional framing per spec §3 & §17. The word "Win" cannot
   * appear within two viewport-screens of any fee or payout amount on these surfaces.
   * Use `marketplaceSubTagline` there instead of `slogan`.
   */
  marketplaceSubTagline: 'Practice the positions that matter.',
  description:
    "Find your next opponent's online games. Build a battle plan. Practice the exact positions that matter.",
  loop: ['Scout', 'Find', 'Practice', 'Pay', 'Improve'] as const,
} as const;

/**
 * Surface classification — which tagline to render where.
 *
 * `master`: prep-focused surfaces (home, /scout, /reports, /p/*, /dashboard, blog).
 * `marketplace`: any surface where match fees / payouts / paid play are visible.
 */
export type BrandSurface = 'master' | 'marketplace';

export function taglineFor(surface: BrandSurface): string {
  return surface === 'marketplace' ? brand.marketplaceSubTagline : brand.slogan;
}

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
