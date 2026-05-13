'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface LobbyChallenge {
  id: string;
  creator_id: string;
  creator_display_name: string | null;
  creator_username: string | null;
  fen: string;
  creator_color: 'w' | 'b' | null;
  time_control: string;
  time_class: string;
  fee_cents: number;
  rating_min: number | null;
  rating_max: number | null;
  games_requested: number;
  games_completed: number;
  notes: string | null;
  created_at: string;
}

export function LobbyCard({
  challenge,
  isOwn,
  signedIn,
}: {
  challenge: LobbyChallenge;
  isOwn: boolean;
  signedIn: boolean;
}) {
  const router = useRouter();
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const creatorLabel = challenge.creator_display_name ?? challenge.creator_username ?? 'A player';

  async function accept() {
    if (!signedIn) {
      router.push(`/login?next=${encodeURIComponent('/practice')}`);
      return;
    }
    setAccepting(true);
    setError(null);
    try {
      const res = await fetch(`/api/practice/challenges/${challenge.id}/accept`, {
        method: 'POST',
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? 'Failed to accept.');
        setAccepting(false);
        return;
      }
      const { matchId } = (await res.json()) as { matchId: string };
      router.push(`/practice/g/${matchId}`);
    } catch {
      setError('Network error.');
      setAccepting(false);
    }
  }

  const oppositeColorLabel =
    challenge.creator_color === 'w'
      ? 'play Black'
      : challenge.creator_color === 'b'
        ? 'play White'
        : 'random color';

  const ratingBand =
    challenge.rating_min !== null || challenge.rating_max !== null
      ? `${challenge.rating_min ?? '–'}–${challenge.rating_max ?? '–'}`
      : null;

  const remaining = challenge.games_requested - challenge.games_completed;

  return (
    <article className="rounded-lg border border-border bg-card p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{creatorLabel}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {challenge.time_control} {challenge.time_class} · you {oppositeColorLabel}
            {ratingBand ? ` · opponent rating ${ratingBand}` : ''}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-display text-2xl font-bold tabular-nums">
            ${(challenge.fee_cents / 100).toFixed(2)}
          </p>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">per game</p>
        </div>
      </header>

      {challenge.notes && (
        <p className="mt-2 rounded bg-muted/40 p-2 text-xs italic text-muted-foreground">
          “{challenge.notes}”
        </p>
      )}

      <footer className="mt-3 flex items-center justify-between gap-3">
        <p className="text-[11px] text-muted-foreground">
          {remaining === challenge.games_requested
            ? `${remaining} game${remaining === 1 ? '' : 's'} requested`
            : `${remaining} of ${challenge.games_requested} games left`}
        </p>
        {isOwn ? (
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            your challenge
          </span>
        ) : (
          <button
            type="button"
            onClick={accept}
            disabled={accepting}
            className="rounded-md bg-accent px-4 py-1.5 text-xs font-semibold text-accent-foreground disabled:opacity-60"
          >
            {accepting ? 'Accepting…' : `Accept · earn $${(challenge.fee_cents / 100).toFixed(2)}`}
          </button>
        )}
      </footer>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </article>
  );
}
