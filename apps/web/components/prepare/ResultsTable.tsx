'use client';

import type { GameRecord, Platform } from '@/lib/prepare/types';

interface Props {
  platform: Platform;
  games: GameRecord[];
  targetHandle: string;
}

function gameUrl(platform: Platform, game: GameRecord): string | null {
  if (platform === 'lichess') {
    return game.id ? `https://lichess.org/${game.id}` : null;
  }
  // chess.com fetcher stores the full url as the id
  if (game.id.startsWith('http')) return game.id;
  return null;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function ResultsTable({ platform, games, targetHandle }: Props) {
  if (games.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-card px-3 py-4 text-center text-[11px] text-muted-foreground">
        No sample games stored for this move.
      </div>
    );
  }
  const target = targetHandle.toLowerCase();
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
        Sample games
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-card text-xs">
        {games.map((g) => {
          const url = gameUrl(platform, g);
          const whiteBold = g.resultText === '1-0';
          const blackBold = g.resultText === '0-1';
          const whiteIsTarget = g.whiteHandle.toLowerCase() === target;
          const row = (
            <span className="flex items-center justify-between gap-2 px-3 py-1.5">
              <span className="flex min-w-0 items-baseline gap-1.5 truncate">
                <span
                  className={`truncate ${whiteBold ? 'font-semibold' : ''} ${whiteIsTarget ? 'text-accent' : 'text-foreground'}`}
                >
                  {g.whiteHandle}
                </span>
                {g.whiteElo ? (
                  <span className="font-mono text-[10px] text-muted-foreground">{g.whiteElo}</span>
                ) : null}
                <span className="text-muted-foreground">{g.resultText}</span>
                <span
                  className={`truncate ${blackBold ? 'font-semibold' : ''} ${!whiteIsTarget ? 'text-accent' : 'text-foreground'}`}
                >
                  {g.blackHandle}
                </span>
                {g.blackElo ? (
                  <span className="font-mono text-[10px] text-muted-foreground">{g.blackElo}</span>
                ) : null}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {formatDate(g.playedAt)}
              </span>
            </span>
          );
          return (
            <li key={g.id}>
              {url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block transition hover:bg-accent/10"
                >
                  {row}
                </a>
              ) : (
                row
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
