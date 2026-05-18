'use client';

/**
 * PlayerCard: one row above and one below the board, showing the player's
 * name, title, country flag, rating, and clock. Mirrors the Lichess layout
 * (cards stacked vertically around the board) and reuses the same
 * Title/Country chips as the public profile + scout result.
 *
 * Anonymity + profile-link rules are resolved server-side and baked into
 * `PlayerInfo`. This component just renders whatever the parent passes.
 */

import Link from 'next/link';
import { CountryBadge, TitleBadge } from '@/app/scout/result-card';

export interface PlayerInfo {
  userId: string;
  displayName: string;
  profileHref: string | null;
  countryIso2: string | null;
  chessTitle: string | null;
  rating: number | null;
}

interface Props {
  player: PlayerInfo;
  color: 'white' | 'black';
  isYou: boolean;
  ms: number;
  active: boolean;
}

export function PlayerCard({ player, color, isYou, ms, active }: Props) {
  const nameNode = player.profileHref ? (
    <Link href={player.profileHref} className="hover:text-accent hover:underline">
      {player.displayName}
    </Link>
  ) : (
    <span>{player.displayName}</span>
  );

  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-md px-3 py-2 ${
        active ? 'bg-accent/15 ring-1 ring-accent/40' : 'bg-card'
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className={`inline-block h-3 w-3 shrink-0 rounded-full border ${
            color === 'white' ? 'border-border bg-white' : 'border-border bg-zinc-900'
          }`}
        />
        <span className="truncate text-sm font-medium text-foreground">
          {nameNode}
          {isYou && <span className="ml-1 text-xs text-muted-foreground">(you)</span>}
        </span>
        {player.chessTitle && <TitleBadge title={player.chessTitle} />}
        {player.countryIso2 && <CountryBadge code={player.countryIso2} />}
        {player.rating != null && (
          <span className="text-xs tabular-nums text-muted-foreground">{player.rating}</span>
        )}
      </div>
      <span
        className={`font-display text-2xl font-bold tabular-nums ${
          ms < 10_000 ? 'text-destructive' : ''
        }`}
      >
        {fmtClock(ms)}
      </span>
    </div>
  );
}

function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (ms < 10_000) {
    const tenths = Math.floor((ms % 1000) / 100);
    return `${m}:${String(s).padStart(2, '0')}.${tenths}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}
