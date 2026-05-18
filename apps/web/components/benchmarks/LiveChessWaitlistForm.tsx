'use client';

import { useState } from 'react';

type TimeClass = 'bullet' | 'blitz' | 'rapid' | 'classical' | 'any';

const TIME_CLASSES: Array<{ value: TimeClass; label: string }> = [
  { value: 'any', label: 'Any time control' },
  { value: 'bullet', label: 'Bullet' },
  { value: 'blitz', label: 'Blitz' },
  { value: 'rapid', label: 'Rapid' },
  { value: 'classical', label: 'Classical' },
];

type State =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'ok' }
  | { kind: 'error'; message: string };

export function LiveChessWaitlistForm() {
  const [email, setEmail] = useState('');
  const [timeClass, setTimeClass] = useState<TimeClass>('any');
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState({ kind: 'submitting' });
    try {
      const res = await fetch('/api/waitlist/live-chess', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, time_class: timeClass }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setState({ kind: 'error', message: json.error ?? 'something went wrong' });
        return;
      }
      setState({ kind: 'ok' });
    } catch {
      setState({ kind: 'error', message: 'network error — try again' });
    }
  }

  if (state.kind === 'ok') {
    return (
      <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm text-emerald-200">
        You&apos;re on the Live Chess list. We&apos;ll email when mutual-webcam matchmaking opens.
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
      <input
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        className="rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-accent focus:outline-none"
      />
      <select
        value={timeClass}
        onChange={(e) => setTimeClass(e.target.value as TimeClass)}
        className="rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-accent focus:outline-none"
      >
        {TIME_CLASSES.map((tc) => (
          <option key={tc.value} value={tc.value}>
            {tc.label}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={state.kind === 'submitting'}
        className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground hover:opacity-90 disabled:opacity-60"
      >
        {state.kind === 'submitting' ? 'Joining…' : 'Join Live Chess waitlist'}
      </button>
      {state.kind === 'error' ? (
        <p className="text-xs text-red-300 sm:col-span-3">{state.message}</p>
      ) : null}
    </form>
  );
}
