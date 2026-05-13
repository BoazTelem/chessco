import Link from 'next/link';

interface PillarTileProps {
  index: number;
  title: string;
  subtitle: string;
  cta?: string;
  href?: string;
  badge?: string;
  children?: React.ReactNode;
}

export function PillarTile({
  index,
  title,
  subtitle,
  cta,
  href,
  badge,
  children,
}: PillarTileProps) {
  const number = (
    <span
      aria-hidden
      className="font-display text-sm font-semibold uppercase tracking-[0.3em] text-accent"
    >
      0{index}
    </span>
  );

  const titleRow = (
    <div className="flex items-baseline justify-between gap-2">
      {number}
      {badge ? (
        <span className="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent">
          {badge}
        </span>
      ) : null}
    </div>
  );

  const body = (
    <>
      {titleRow}
      <h2 className="mt-3 font-display text-xl font-semibold text-foreground">{title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
      {children ? <div className="mt-4">{children}</div> : null}
      {cta ? (
        <div className="mt-5 inline-flex items-center gap-1 text-sm font-semibold text-accent">
          {cta} <span aria-hidden>→</span>
        </div>
      ) : null}
    </>
  );

  const className =
    'group flex h-full flex-col rounded-xl border border-border bg-card p-5 text-left transition hover:border-accent/60 hover:bg-card/80 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

  if (href) {
    return (
      <Link href={href} className={className}>
        {body}
      </Link>
    );
  }

  return <div className={className}>{body}</div>;
}
