import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { brand } from '@chessco/ui';
import { ConditionalFooter } from '@/components/site/ConditionalFooter';
import { PracticePresence } from '@/components/practice/PracticePresence';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: `${brand.name} — ${brand.slogan}`,
    template: `%s | ${brand.name}`,
  },
  description: brand.description,
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? `https://${brand.domain}`),
  // Icons are emitted via file conventions: app/icon.svg (flat gold C),
  // app/icon1.tsx (sized PNG fallbacks), app/apple-icon.tsx (180px PNG),
  // app/opengraph-image.tsx (1200x630 social card).
  openGraph: {
    title: `${brand.name} — ${brand.slogan}`,
    description: brand.description,
    url: `https://${brand.domain}`,
    siteName: brand.name,
    type: 'website',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark ${inter.variable} ${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="flex min-h-screen flex-col bg-background font-sans text-foreground antialiased">
        <div className="flex-1">{children}</div>
        <ConditionalFooter />
        <PracticePresence />
      </body>
    </html>
  );
}
