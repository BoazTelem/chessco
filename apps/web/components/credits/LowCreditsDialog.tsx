'use client';

/**
 * LowCreditsDialog: shown when a Practice action is blocked by HTTP 402
 * insufficient-credits. Offers two recovery paths: invite friends (20 credits
 * per verified signup, capped at 100) and earn by playing other players'
 * paid practice in the lobby. Subscription upgrade is a Phase 1 follow-up.
 */

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

const REFERRAL_BONUS_PER_FRIEND = 20;

export function LowCreditsDialog({
  open,
  onClose,
  referralCode,
  referralCreditsEarned,
  referralCreditsCap,
}: {
  open: boolean;
  onClose: () => void;
  referralCode: string;
  referralCreditsEarned: number;
  referralCreditsCap: number;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) setCopied(false);
  }, [open]);

  if (!open) return null;

  const origin =
    typeof window !== 'undefined'
      ? window.location.origin
      : (process.env.NEXT_PUBLIC_APP_URL ?? 'https://chessco.app');
  const referralUrl = `${origin}/r/${referralCode}`;
  const capReached = referralCreditsEarned >= referralCreditsCap;

  async function copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(referralUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can fail in insecure contexts; the read-only input
      // remains as a manual-copy fallback.
    }
  }

  async function shareLink(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.share) return;
    try {
      await navigator.share({
        title: 'Join me on Chessco',
        text: 'Play practice chess on Chessco. I get 20 credits when you sign up.',
        url: referralUrl,
      });
    } catch {
      // User cancelled the share sheet; nothing to do.
    }
  }

  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="low-credits-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="low-credits-title" className="font-display text-lg font-semibold">
              You&apos;re out of credits
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Get more credits to keep publishing challenges and direct invites.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent/10"
          >
            ✕
          </button>
        </div>

        <section className="mt-4 rounded-md border border-accent/30 bg-accent/5 p-3">
          <h3 className="font-semibold">Invite friends</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Get {REFERRAL_BONUS_PER_FRIEND} credits each time a friend signs up and verifies their
            email.{' '}
            <span className="font-medium text-foreground">
              {referralCreditsEarned}/{referralCreditsCap}
            </span>{' '}
            earned.
          </p>

          <div className="mt-3 flex gap-2">
            <input
              type="text"
              readOnly
              value={referralUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
            />
            <button
              type="button"
              onClick={copyLink}
              disabled={capReached}
              className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-accent-foreground disabled:opacity-60"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            {canShare && (
              <button
                type="button"
                onClick={shareLink}
                disabled={capReached}
                className="rounded-md border border-border px-3 py-1 text-xs font-semibold disabled:opacity-60"
              >
                Share
              </button>
            )}
          </div>

          {capReached && (
            <p className="mt-2 text-xs text-muted-foreground">
              You&apos;ve hit the referral cap. Earn more by playing paid practice below.
            </p>
          )}
        </section>

        <section className="mt-3 rounded-md border border-border p-3">
          <h3 className="font-semibold">Earn by practice</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Accept paid practice challenges in the lobby. You earn 1 credit for each completed game.
          </p>
          <Link
            href="/practice"
            onClick={onClose}
            className="mt-2 inline-block w-full rounded-md bg-accent px-3 py-2 text-center text-xs font-semibold text-accent-foreground"
          >
            Browse the practice lobby
          </Link>
        </section>
      </div>
    </div>
  );
}
