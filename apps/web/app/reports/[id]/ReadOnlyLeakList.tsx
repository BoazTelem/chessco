import type { Leak } from '@/lib/leaks/types';

function formatLine(sanPath: string[]): string {
  const parts: string[] = [];
  for (let i = 0; i < sanPath.length; i += 1) {
    const moveNum = Math.floor(i / 2) + 1;
    if (i % 2 === 0) parts.push(`${moveNum}.${sanPath[i]}`);
    else parts.push(sanPath[i]!);
  }
  return parts.join(' ');
}

function formatPct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

export function ReadOnlyLeakList({ leaks }: { leaks: Leak[] }) {
  return (
    <ul className="mt-4 space-y-3">
      {leaks.map((leak) => (
        <li key={leak.fingerprint} className="rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              {leak.kind === 'personalized'
                ? 'In your repertoire'
                : leak.kind === 'surprise'
                  ? 'New line worth learning'
                  : 'Line to avoid (your slip)'}
            </p>
            <p className="text-xs text-muted-foreground">score {leak.score.toFixed(3)}</p>
          </div>
          <p className="mt-2 font-mono text-sm">
            {formatLine(leak.sanPath)}{' '}
            <span className="text-muted-foreground">
              {leak.opponentBadMoveSan}? →{' '}
              <span className="font-semibold text-foreground">{leak.userMoveSan}</span>
            </span>
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Sample</dt>
              <dd>{leak.stats.gamesCount} games</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Blunder rate</dt>
              <dd>{formatPct(leak.stats.blunderRate)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Mistake rate</dt>
              <dd>{formatPct(leak.stats.mistakeRate)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Avg cp loss</dt>
              <dd>{leak.stats.avgCpLoss.toFixed(0)}</dd>
            </div>
          </dl>
          {leak.opponentBetterMoveSan ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Better for them:{' '}
              <code className="rounded bg-muted px-1 py-0.5">{leak.opponentBetterMoveSan}</code>
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
