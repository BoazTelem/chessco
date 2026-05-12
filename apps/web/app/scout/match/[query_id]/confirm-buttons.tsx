'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Confirm / reject feedback for a single match candidate.
 *
 *   null  → "✓ This is them" + "✗ Not them" buttons
 *   true  → green "Confirmed ✓" pill (click to undo)
 *   false → grey "Marked wrong ✗" pill (click to undo)
 *
 * On change, calls /api/candidate/{id}/feedback. Auth-gated: signed-out
 * users see a sign-in prompt instead of the buttons.
 */
export function ConfirmButtons({
  candidateId,
  initial,
  signedIn,
  nextPath,
}: {
  candidateId: number;
  initial: boolean | null;
  signedIn: boolean;
  nextPath: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<boolean | null>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!signedIn) {
    return (
      <a
        href={`/login?next=${encodeURIComponent(nextPath)}`}
        className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        Sign in to confirm
      </a>
    );
  }

  async function send(next: boolean | null) {
    setLoading(true);
    setError(null);
    const prev = state;
    setState(next); // optimistic
    try {
      const res = await fetch(`/api/candidate/${candidateId}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      // Refresh the server-rendered match page so the new state shows
      // up consistently if the user reloads.
      router.refresh();
    } catch (err) {
      setState(prev); // rollback
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setLoading(false);
    }
  }

  if (state === true) {
    return (
      <button
        type="button"
        onClick={() => send(null)}
        disabled={loading}
        className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-500 transition hover:bg-emerald-500/20 disabled:opacity-50"
        title="Click to undo"
      >
        ✓ Confirmed
      </button>
    );
  }
  if (state === false) {
    return (
      <button
        type="button"
        onClick={() => send(null)}
        disabled={loading}
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground transition hover:text-foreground disabled:opacity-50"
        title="Click to undo"
      >
        ✗ Marked wrong
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => send(true)}
        disabled={loading}
        className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/5 px-2.5 py-1 text-xs font-medium text-emerald-500 transition hover:bg-emerald-500/15 disabled:opacity-50"
      >
        ✓ This is them
      </button>
      <button
        type="button"
        onClick={() => send(false)}
        disabled={loading}
        className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground transition hover:border-rose-500/40 hover:text-rose-500 disabled:opacity-50"
      >
        ✗ Not them
      </button>
      {error && <span className="text-[10px] text-rose-500">{error}</span>}
    </div>
  );
}
