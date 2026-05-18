import type { FetchProgress } from '@/lib/prepare/types';

interface Props {
  progress: FetchProgress;
  /** Games matching current filters; shown as the headline number when fetch is done. */
  filteredGameCount: number;
}

export function FetchProgressBar({ progress, filteredGameCount }: Props) {
  if (progress.phase === 'idle') return null;
  const pct =
    progress.estimatedTotal && progress.estimatedTotal > 0
      ? Math.min(100, Math.round((progress.fetchedGames / progress.estimatedTotal) * 100))
      : null;
  const isHydrating = progress.phase === 'hydrating';
  const isWorking = progress.phase === 'fetching' || progress.phase === 'parsing' || isHydrating;
  const isDone = progress.phase === 'done';

  // While fetching: "fetched / ~estimated games" reflects the raw pull rate.
  // When done: switch to the filtered count, that's the real corpus the tree
  // is built from. Total fetched moves to a small subtext for context.
  const headline = isHydrating
    ? 'Loading cached games…'
    : isDone
      ? `${filteredGameCount.toLocaleString()} games match filters`
      : `${progress.fetchedGames.toLocaleString()}${
          progress.estimatedTotal ? ` / ~${progress.estimatedTotal.toLocaleString()}` : ''
        } games`;
  const subtext = isDone
    ? progress.fetchedGames > filteredGameCount
      ? `of ${progress.fetchedGames.toLocaleString()} fetched`
      : null
    : null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-muted-foreground">
          {isDone
            ? 'Done'
            : progress.phase === 'error'
              ? 'Error'
              : isHydrating
                ? 'Loading'
                : 'Building'}
          {progress.currentLabel ? ` · ${progress.currentLabel}` : ''}
        </span>
        <span className="flex items-baseline gap-2 font-mono text-foreground">
          {subtext ? <span className="text-[10px] text-muted-foreground">{subtext}</span> : null}
          <span>{headline}</span>
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full bg-accent transition-all ${isWorking ? 'animate-pulse' : ''}`}
          style={{ width: isDone ? '100%' : pct !== null ? `${pct}%` : isWorking ? '40%' : '100%' }}
        />
      </div>
      {progress.errorMessage ? (
        <p className="text-xs text-destructive">{progress.errorMessage}</p>
      ) : null}
    </div>
  );
}
