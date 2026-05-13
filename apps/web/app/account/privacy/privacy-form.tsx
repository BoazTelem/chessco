'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { setProfileVisibility } from './actions';

type Visibility = 'public' | 'private' | 'coach_public_player_private';

const OPTIONS: Array<{
  value: Visibility;
  label: string;
  description: string;
  disabled?: boolean;
  disabledNote?: string;
}> = [
  {
    value: 'public',
    label: 'Public',
    description:
      'Your profile at /u/<username> shows your name, linked online accounts, and Practice games. Lobby cards link to your profile.',
  },
  {
    value: 'private',
    label: 'Private',
    description:
      'Your profile page only shows your username. No games, no linked accounts. Lobby cards still show your name but don’t link to your profile.',
  },
  {
    value: 'coach_public_player_private',
    label: 'Coach (public coach page, private player history)',
    description: 'Public coach profile, but your player history stays hidden.',
    disabled: true,
    disabledNote: 'Coming with coach plan',
  },
];

export function PrivacyForm({
  initial,
  username,
}: {
  initial: Visibility;
  username: string | null;
}) {
  const [value, setValue] = useState<Visibility>(initial);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function choose(next: Visibility) {
    if (next === value) return;
    setValue(next);
    setStatus('idle');
    setError(null);
    const fd = new FormData();
    fd.set('value', next);
    startTransition(async () => {
      const res = await setProfileVisibility(fd);
      if (res.ok) {
        setStatus('saved');
        setTimeout(() => setStatus('idle'), 1500);
      } else {
        setStatus('error');
        setError(res.error ?? 'Failed to save.');
        setValue(initial);
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {OPTIONS.map((opt) => {
          const active = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              disabled={opt.disabled || isPending}
              onClick={() => choose(opt.value)}
              className={`block w-full rounded-lg border p-4 text-left transition ${
                active ? 'border-accent bg-accent/10' : 'border-border bg-card hover:bg-muted/40'
              } ${opt.disabled ? 'cursor-not-allowed opacity-50' : ''}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">
                    {opt.label}
                    {opt.disabled && opt.disabledNote && (
                      <span className="ml-2 text-[10px] font-normal uppercase tracking-wider text-muted-foreground">
                        · {opt.disabledNote}
                      </span>
                    )}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{opt.description}</p>
                </div>
                <span
                  aria-hidden
                  className={`mt-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                    active ? 'border-accent bg-accent' : 'border-border'
                  }`}
                >
                  {active && <span className="h-1.5 w-1.5 rounded-full bg-accent-foreground" />}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        {isPending && 'Saving…'}
        {!isPending && status === 'saved' && 'Saved.'}
        {!isPending && status === 'error' && (error ?? 'Failed to save.')}
      </p>

      {username && (
        <p className="text-xs text-muted-foreground">
          Your profile URL:{' '}
          <Link href={`/u/${username}`} className="text-accent hover:underline">
            /u/{username}
          </Link>
        </p>
      )}
    </div>
  );
}
