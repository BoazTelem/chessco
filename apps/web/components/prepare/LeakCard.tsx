'use client';

import type { Leak, LeakKind } from '@/lib/leaks/types';

export type LeakDto =
  | ({ locked: false; kind: LeakKind } & Leak)
  | {
      locked: true;
      kind: LeakKind;
      fingerprint: string;
      stats: {
        gamesCount: number;
        userReach: number;
        opponentReach: number;
      };
    };

interface Props {
  leak: LeakDto;
  onUnlock: (fingerprint: string) => Promise<void>;
  isUnlocking: boolean;
}

function formatPct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

function formatLineFromSan(sanPath: string[]): string {
  const parts: string[] = [];
  for (let i = 0; i < sanPath.length; i += 1) {
    const moveNum = Math.floor(i / 2) + 1;
    if (i % 2 === 0) parts.push(`${moveNum}.${sanPath[i]}`);
    else parts.push(sanPath[i]!);
  }
  return parts.join(' ');
}

export function LeakCard({ leak, onUnlock, isUnlocking }: Props) {
  if (leak.locked) {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Locked leak</p>
            <p className="mt-1 text-sm text-foreground">
              {leak.stats.gamesCount} game{leak.stats.gamesCount === 1 ? '' : 's'} matched ·
              opponent reaches this {formatPct(leak.stats.opponentReach)} of the time
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Reveal to see the position, the move they often play, and your recommended response.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void onUnlock(leak.fingerprint)}
            disabled={isUnlocking}
            className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isUnlocking ? 'Unlocking…' : 'Unlock for 1 credit'}
          </button>
        </div>
      </div>
    );
  }

  const kindLabel =
    leak.kind === 'surprise'
      ? 'Surprise line · free'
      : leak.kind === 'own'
        ? 'Where you slip up'
        : 'Personalized leak';
  const borderColor = leak.kind === 'own' ? 'border-destructive/40' : 'border-accent/40';
  const labelColor = leak.kind === 'own' ? 'text-destructive' : 'text-accent';
  const lineText =
    leak.sanPath.length > 0 ? formatLineFromSan(leak.sanPath) : '(starting position)';

  return (
    <div className={`rounded-lg border ${borderColor} bg-card p-4`}>
      <p className={`text-xs uppercase tracking-wider ${labelColor}`}>{kindLabel}</p>
      <p className="mt-2 font-mono text-sm text-foreground">{lineText}</p>
      <div className="mt-2 grid gap-1 text-xs text-muted-foreground">
        {leak.kind === 'own' ? (
          <>
            <p>
              You played <span className="font-semibold text-destructive">{leak.userMoveSan}</span>{' '}
              here — avg cp-loss {Math.round(leak.stats.avgCpLoss)}, blunder rate{' '}
              {formatPct(leak.stats.blunderRate)}
            </p>
            <p>
              {leak.stats.gamesCount} of your game
              {leak.stats.gamesCount === 1 ? '' : 's'} · opponent reaches this position{' '}
              {formatPct(leak.stats.opponentReach)} of the time as their color
            </p>
          </>
        ) : leak.userMoveSan ? (
          <>
            <p>
              Your move: <span className="font-semibold text-foreground">{leak.userMoveSan}</span>
              {' → opponent often replies '}
              <span className="font-semibold text-destructive">{leak.opponentBadMoveSan}</span>
            </p>
            <p>
              {leak.stats.gamesCount} game{leak.stats.gamesCount === 1 ? '' : 's'} · avg cp-loss{' '}
              {Math.round(leak.stats.avgCpLoss)} · blunder rate {formatPct(leak.stats.blunderRate)}{' '}
              · they pick this {formatPct(leak.stats.badMoveShare)} of the time
            </p>
          </>
        ) : (
          <>
            <p>
              Opponent plays{' '}
              <span className="font-semibold text-destructive">{leak.opponentBadMoveSan}</span> here
              when given the chance
            </p>
            <p>
              {leak.stats.gamesCount} game{leak.stats.gamesCount === 1 ? '' : 's'} · avg cp-loss{' '}
              {Math.round(leak.stats.avgCpLoss)} · blunder rate {formatPct(leak.stats.blunderRate)}{' '}
              · they pick this {formatPct(leak.stats.badMoveShare)} of the time
            </p>
          </>
        )}
      </div>
    </div>
  );
}
