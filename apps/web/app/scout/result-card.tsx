import Link from 'next/link';
import type { SearchResult } from './types';

export function ResultCard({ result }: { result: SearchResult }) {
  const ratings: Array<[string, number | null]> = [
    ['Std', result.rating_standard],
    ['Rapid', result.rating_rapid],
    ['Blitz', result.rating_blitz],
  ];

  return (
    <Link
      href={`/p/${result.id}`}
      className="block rounded-lg border border-border bg-card p-4 transition hover:border-accent/40 hover:bg-card/80"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <FederationBadge code={result.federation_id} />
            {result.title && <TitleBadge title={result.title} />}
            {result.country && <CountryBadge code={result.country} />}
          </div>
          <p className="mt-2 truncate text-base font-medium text-foreground">{result.name}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            FIDE ID {result.federation_player_id}
            {result.birth_year && <> · born {result.birth_year}</>}
          </p>
        </div>

        <dl className="flex shrink-0 items-center gap-3 text-right">
          {ratings.map(([label, r]) => (
            <div key={label} className="min-w-[3rem]">
              <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {label}
              </dt>
              <dd className="text-base font-semibold tabular-nums">{r ?? '—'}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Link>
  );
}

export function FederationBadge({ code }: { code: string }) {
  return (
    <span className="rounded-md bg-muted/40 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {code}
    </span>
  );
}

export function TitleBadge({ title }: { title: string }) {
  const color =
    title === 'GM' || title === 'WGM'
      ? 'bg-accent/15 text-accent border-accent/30'
      : title === 'IM' || title === 'WIM'
        ? 'bg-accent/10 text-accent border-accent/20'
        : 'bg-muted/40 text-muted-foreground border-border';

  return (
    <span
      className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${color}`}
    >
      {title}
    </span>
  );
}

export function CountryBadge({ code }: { code: string }) {
  return (
    <span className="rounded-md border border-border bg-background px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {code}
    </span>
  );
}
