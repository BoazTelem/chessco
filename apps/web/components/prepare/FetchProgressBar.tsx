import type { FetchProgress } from '@/lib/prepare/types';

interface Props {
  progress: FetchProgress;
}

export function FetchProgressBar({ progress }: Props) {
  if (progress.phase === 'idle') return null;
  const pct =
    progress.estimatedTotal && progress.estimatedTotal > 0
      ? Math.min(100, Math.round((progress.fetchedGames / progress.estimatedTotal) * 100))
      : null;
  const isWorking = progress.phase === 'fetching' || progress.phase === 'parsing';

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">
          {progress.phase === 'done' ? 'Done' : progress.phase === 'error' ? 'Error' : 'Building'}
          {progress.currentLabel ? ` · ${progress.currentLabel}` : ''}
        </span>
        <span className="font-mono text-foreground">
          {progress.fetchedGames.toLocaleString()}
          {progress.estimatedTotal ? ` / ~${progress.estimatedTotal.toLocaleString()}` : ''} games
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full bg-accent transition-all ${isWorking ? 'animate-pulse' : ''}`}
          style={{ width: pct !== null ? `${pct}%` : isWorking ? '40%' : '100%' }}
        />
      </div>
      {progress.errorMessage ? (
        <p className="text-xs text-destructive">{progress.errorMessage}</p>
      ) : null}
    </div>
  );
}
