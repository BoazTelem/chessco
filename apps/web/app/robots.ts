import type { MetadataRoute } from 'next';
import { brand } from '@chessco/ui';

const ORIGIN = (process.env.NEXT_PUBLIC_APP_URL ?? `https://${brand.domain}`).replace(/\/$/, '');

const DISALLOW = [
  '/account/',
  '/admin/',
  '/api/',
  '/dashboard',
  '/scout/history',
  '/scout/match/',
  '/practice/g/',
  '/login',
  '/signup',
];

const AI_BOTS = [
  'GPTBot',
  'ClaudeBot',
  'PerplexityBot',
  'Google-Extended',
  'OAI-SearchBot',
  'Bingbot',
] as const;

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: '*', allow: '/', disallow: DISALLOW },
      ...AI_BOTS.map((userAgent) => ({ userAgent, allow: '/', disallow: DISALLOW })),
    ],
    sitemap: `${ORIGIN}/sitemap.xml`,
    host: ORIGIN,
  };
}
