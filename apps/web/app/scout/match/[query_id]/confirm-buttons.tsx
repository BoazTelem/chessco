'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export type CandidateFeedback = 'correct' | 'probably_correct' | 'probably_wrong' | 'wrong';

const FEEDBACK_OPTIONS: Array<{
  value: CandidateFeedback;
  label: string;
  activeClass: string;
  idleClass: string;
}> = [
  {
    value: 'correct',
    label: '100% right',
    activeClass: 'border-emerald-500/50 bg-emerald-500/15 text-emerald-500',
    idleClass: 'border-emerald-500/30 bg-emerald-500/5 text-emerald-500',
  },
  {
    value: 'probably_correct',
    label: 'Feels right',
    activeClass: 'border-lime-500/50 bg-lime-500/15 text-lime-500',
    idleClass: 'border-border bg-background text-muted-foreground hover:text-lime-500',
  },
  {
    value: 'probably_wrong',
    label: 'Feels wrong',
    activeClass: 'border-amber-500/50 bg-amber-500/15 text-amber-500',
    idleClass: 'border-border bg-background text-muted-foreground hover:text-amber-500',
  },
  {
    value: 'wrong',
    label: '100% wrong',
    activeClass: 'border-rose-500/50 bg-rose-500/15 text-rose-500',
    idleClass: 'border-rose-500/30 bg-rose-500/5 text-rose-500',
  },
];

export function ConfirmButtons({
  candidateId,
  initial,
  signedIn,
  nextPath,
}: {
  candidateId: number;
  initial: CandidateFeedback | null;
  signedIn: boolean;
  nextPath: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<CandidateFeedback | null>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!signedIn) {
    return (
      <a
        href={`/login?next=${encodeURIComponent(nextPath)}`}
        className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        Sign in to rate this result
      </a>
    );
  }

  async function send(next: CandidateFeedback | null) {
    setLoading(true);
    setError(null);
    const prev = state;
    setState(next);
    try {
      const res = await fetch(`/api/candidate/${candidateId}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (err) {
      setState(prev);
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {FEEDBACK_OPTIONS.map((option) => {
          const active = state === option.value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => send(active ? null : option.value)}
              disabled={loading}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium transition disabled:opacity-50 ${
                active ? option.activeClass : option.idleClass
              }`}
              title={active ? 'Click to undo' : undefined}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {state ? (
        <p className="text-[10px] text-muted-foreground">
          Thanks. This feedback helps calibrate future matching and benchmark copy.
        </p>
      ) : null}
      {error && <p className="text-[10px] text-rose-500">{error}</p>}
    </div>
  );
}
