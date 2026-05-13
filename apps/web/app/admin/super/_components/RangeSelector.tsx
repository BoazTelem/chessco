import Link from 'next/link';
import { RANGES, type Range } from '../_lib/range';

export function RangeSelector({ current, basePath }: { current: Range; basePath: string }) {
  return (
    <nav className="flex gap-1 rounded-md border border-border bg-background p-1 text-xs">
      {RANGES.map((r) => {
        const active = r.key === current;
        return (
          <Link
            key={r.key}
            href={`${basePath}?range=${r.key}`}
            className={`rounded px-2.5 py-1 transition ${
              active
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            {r.label}
          </Link>
        );
      })}
    </nav>
  );
}
