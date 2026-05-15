'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { BOARD_BORDER, BOARD_DARK_SQUARE, BOARD_LIGHT_SQUARE } from '../prepare/board-theme';

const Chessboard = dynamic(() => import('react-chessboard').then((m) => m.Chessboard), {
  ssr: false,
  loading: () => (
    <div
      className="aspect-square w-full rounded-md border bg-muted/30"
      style={{ borderColor: BOARD_BORDER }}
    />
  ),
});

export interface LobbyChallenge {
  id: string;
  creator_id: string;
  creator_display_name: string | null;
  creator_username: string | null;
  creator_visibility: 'public' | 'private' | 'coach_public_player_private';
  fen: string;
  creator_color: 'w' | 'b' | null;
  time_control: string;
  time_class: string;
  fee_cents: number;
  funding_type: 'cash' | 'credits';
  credit_cost: number;
  rating_min: number | null;
  rating_max: number | null;
  games_requested: number;
  games_completed: number;
  notes: string | null;
  opening_name: string | null;
  anonymous: boolean;
  creator_rating: number | null;
  created_at: string;
}

const MINI_BOARD = 160;

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

  const creatorLabel = challenge.anonymous
    ? 'Anonymous'
    : (challenge.creator_display_name ?? challenge.creator_username ?? 'A player');
  const creatorRatingLabel =
    challenge.creator_rating != null ? `· ${challenge.creator_rating}` : '';
  // Name links to /u/<username> only when the creator's profile is public AND
  // they haven't anonymized this specific challenge AND we have a username.
  const creatorProfileHref =
    !challenge.anonymous && challenge.creator_visibility === 'public' && challenge.creator_username
      ? `/u/${challenge.creator_username}`
      : null;

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
        // 409 = stale state (status no longer 'open', creator went offline,
        // direct-invite mismatch). The card we just clicked is out of date —
        // refresh the lobby so it disappears immediately instead of sitting
        // there with an error label.
        if (res.status === 409) router.refresh();
        return;
      }
      const { matchId } = (await res.json()) as { matchId: string };
      router.push(`/practice/g/${matchId}`);
    } catch {
      setError('Network error.');
      setAccepting(false);
    }
  }

  // Show the board from the opponent's perspective: if the creator plays White,
  // the opponent plays Black, so flip the board to Black-on-bottom.
  const orientation: 'white' | 'black' = challenge.creator_color === 'w' ? 'black' : 'white';

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
  // Legacy cash challenges still flow through here while in-flight matches
  // settle. Treat anything with fee_cents > 0 as legacy cash; everything else
  // is the new world (free if credit_cost === 0, paid otherwise).
  const isLegacyCash = challenge.fee_cents > 0;
  const isFreePractice = !isLegacyCash && challenge.credit_cost === 0;
  const isPaidPractice = !isLegacyCash && challenge.credit_cost > 0;

  return (
    <article className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start gap-4">
        <div
          className="shrink-0 overflow-hidden rounded-md"
          style={{ width: MINI_BOARD, border: `2px solid ${BOARD_BORDER}` }}
        >
          <Chessboard
            position={challenge.fen}
            boardWidth={MINI_BOARD - 4}
            boardOrientation={orientation}
            arePiecesDraggable={false}
            customDarkSquareStyle={{ backgroundColor: BOARD_DARK_SQUARE }}
            customLightSquareStyle={{ backgroundColor: BOARD_LIGHT_SQUARE }}
            showBoardNotation={false}
          />
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">
                {creatorProfileHref ? (
                  <Link href={creatorProfileHref} className="hover:text-accent hover:underline">
                    {creatorLabel}
                  </Link>
                ) : (
                  creatorLabel
                )}{' '}
                {creatorRatingLabel && (
                  <span className="text-muted-foreground">{creatorRatingLabel}</span>
                )}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {challenge.time_control} {challenge.time_class} · you {oppositeColorLabel}
                {ratingBand ? ` · opponent rating ${ratingBand}` : ''}
              </p>
              {challenge.opening_name && (
                <p className="mt-1 text-[11px] font-medium uppercase tracking-wider text-accent">
                  {challenge.opening_name}
                </p>
              )}
            </div>
            <div className="shrink-0 text-right">
              {isFreePractice ? (
                <>
                  <p className="font-display text-2xl font-bold tabular-nums text-muted-foreground">
                    Free
                  </p>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    practice
                  </p>
                </>
              ) : isPaidPractice ? (
                <>
                  <p className="font-display text-2xl font-bold tabular-nums">1</p>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    credit per game
                  </p>
                </>
              ) : (
                <>
                  <p className="font-display text-2xl font-bold tabular-nums">
                    ${(challenge.fee_cents / 100).toFixed(2)}
                  </p>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    per game
                  </p>
                </>
              )}
            </div>
          </header>

          {challenge.notes && (
            <p className="mt-2 rounded bg-muted/40 p-2 text-xs italic text-muted-foreground">
              “{challenge.notes}”
            </p>
          )}

          <footer className="mt-auto flex items-center justify-between gap-3 pt-3">
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
                {accepting
                  ? 'Accepting...'
                  : isFreePractice
                    ? 'Accept - free practice'
                    : isPaidPractice
                      ? 'Accept - earn 1 credit per game'
                      : `Accept - earn $${(challenge.fee_cents / 100).toFixed(2)}`}
              </button>
            )}
          </footer>
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </div>
      </div>
    </article>
  );
}
