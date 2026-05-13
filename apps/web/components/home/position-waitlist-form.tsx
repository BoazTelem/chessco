'use client';

import { useId, useState } from 'react';

type TimeClass = 'any' | 'bullet' | 'blitz' | 'rapid' | 'classical';

const TIME_CLASSES: { value: TimeClass; label: string }[] = [
  { value: 'any', label: 'Any' },
  { value: 'bullet', label: 'Bullet' },
  { value: 'blitz', label: 'Blitz' },
  { value: 'rapid', label: 'Rapid' },
  { value: 'classical', label: 'Classical' },
];

type Status = 'idle' | 'submitting' | 'success' | 'error';

export function PositionWaitlistForm() {
  const id = useId();
  const [email, setEmail] = useState('');
  const [timeClass, setTimeClass] = useState<TimeClass>('any');
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus('submitting');
    setErrorMsg('');
    try {
      const res = await fetch('/api/waitlist/position-practice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, time_class: timeClass }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setErrorMsg(body.error ?? 'Something went wrong.');
        setStatus('error');
        return;
      }
      setStatus('success');
      setEmail('');
    } catch {
      setErrorMsg('Network error — try again.');
      setStatus('error');
    }
  }

  if (status === 'success') {
    return (
      <p className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-foreground">
        You&rsquo;re on the list. We&rsquo;ll email you when sparring opens.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <label htmlFor={`${id}-email`} className="sr-only">
        Email
      </label>
      <input
        id={`${id}-email`}
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        className="block w-full rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
      />
      <div className="flex gap-2">
        <label htmlFor={`${id}-class`} className="sr-only">
          Time class
        </label>
        <select
          id={`${id}-class`}
          value={timeClass}
          onChange={(e) => setTimeClass(e.target.value as TimeClass)}
          className="rounded-md border border-border bg-background px-2 py-2 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        >
          {TIME_CLASSES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={status === 'submitting'}
          className="flex-1 rounded-md bg-accent px-3 py-2 text-sm font-semibold text-accent-foreground transition hover:opacity-90 disabled:opacity-60"
        >
          {status === 'submitting' ? 'Joining…' : 'Notify me'}
        </button>
      </div>
      {status === 'error' ? (
        <p className="text-xs text-destructive" role="alert">
          {errorMsg}
        </p>
      ) : null}
    </form>
  );
}
