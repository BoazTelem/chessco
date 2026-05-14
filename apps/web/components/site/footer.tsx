import Link from 'next/link';
import { brand } from '@chessco/ui';
import { ChesscoMark } from '@/lib/logo';

const SUPPORT_EMAIL = 'support@chessco.org';

function FooterColumn({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-[0.25em] text-muted-foreground">
        {label}
      </p>
      <ul className="mt-3 space-y-2 text-sm">{children}</ul>
    </div>
  );
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  const external = href.startsWith('mailto:') || href.startsWith('http');
  return (
    <li>
      <Link
        href={href}
        className="text-muted-foreground transition-colors hover:text-foreground"
        {...(external ? { rel: 'noopener noreferrer' } : {})}
      >
        {children}
      </Link>
    </li>
  );
}

export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-border bg-card/30">
      <div className="container mx-auto px-4 py-10 md:py-12">
        <div className="grid gap-8 md:grid-cols-4">
          <div className="md:col-span-2">
            <Link
              href="/"
              aria-label={brand.name}
              className="inline-flex items-center gap-2 hover:opacity-80"
            >
              <ChesscoMark className="h-5 w-5" />
              <span className="font-display text-sm font-semibold uppercase tracking-[0.3em] text-accent">
                {brand.name}
              </span>
            </Link>
            <p className="mt-3 max-w-sm text-xs leading-relaxed text-muted-foreground">
              {brand.description}
            </p>
          </div>

          <FooterColumn label="Product">
            <FooterLink href="/scout">Scout</FooterLink>
            <FooterLink href="/prepare">Prepare</FooterLink>
            <FooterLink href="/practice">Practice</FooterLink>
            <FooterLink href="/benchmarks">Benchmarks</FooterLink>
          </FooterColumn>

          <FooterColumn label="Legal">
            <FooterLink href="/terms">Terms of Use</FooterLink>
            <FooterLink href="/privacy">Privacy Policy</FooterLink>
            <FooterLink href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</FooterLink>
          </FooterColumn>
        </div>

        <div className="mt-10 flex flex-col gap-2 border-t border-border pt-6 text-xs text-muted-foreground md:flex-row md:items-center md:justify-between">
          <p>
            © {year} {brand.name}. All rights reserved.
          </p>
          <p className="text-[10px] uppercase tracking-[0.25em]">{brand.slogan}</p>
        </div>
      </div>
    </footer>
  );
}
