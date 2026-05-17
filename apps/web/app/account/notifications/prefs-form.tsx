'use client';

import { useState, useTransition } from 'react';
import { setNotificationPrefs } from './actions';

interface Initial {
  moderation_email: boolean;
  credits_email: boolean;
  social_email: boolean;
}

const TOGGLES: Array<{ key: keyof Initial; label: string; description: string }> = [
  {
    key: 'moderation_email',
    label: 'Moderation actions',
    description: 'Bans, warnings, and fairplay decisions on your account. Strongly recommended.',
  },
  {
    key: 'credits_email',
    label: 'Credit events',
    description: 'Referral bonuses, link bonuses, and practice rewards landing in your wallet.',
  },
  {
    key: 'social_email',
    label: 'Social events',
    description: 'Sparring invitations received, accepted, or declined. Coach acceptances.',
  },
];

export function PrefsForm({ initial }: { initial: Initial }) {
  const [prefs, setPrefs] = useState<Initial>(initial);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function toggle(key: keyof Initial) {
    const next: Initial = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    setStatus('idle');
    setError(null);
    const fd = new FormData();
    fd.set('moderation_email', String(next.moderation_email));
    fd.set('credits_email', String(next.credits_email));
    fd.set('social_email', String(next.social_email));
    startTransition(async () => {
      const res = await setNotificationPrefs(fd);
      if (res.ok) {
        setStatus('saved');
        setTimeout(() => setStatus('idle'), 1500);
      } else {
        setStatus('error');
        setError(res.error ?? 'Failed to save.');
        setPrefs(prefs);
      }
    });
  }

  return (
    <div className="space-y-3">
      {TOGGLES.map((t) => {
        const enabled = prefs[t.key];
        return (
          <label
            key={t.key}
            className="flex items-start justify-between gap-4 rounded-lg border border-border bg-card p-4"
          >
            <div className="flex-1">
              <p className="text-sm font-semibold">{t.label}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t.description}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              disabled={isPending}
              onClick={() => toggle(t.key)}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                enabled ? 'bg-accent' : 'bg-muted'
              } disabled:opacity-50`}
            >
              <span
                aria-hidden="true"
                className={`inline-block h-4 w-4 transform rounded-full bg-background transition ${
                  enabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </label>
        );
      })}

      <p className="text-xs text-muted-foreground">
        {isPending && 'Saving…'}
        {!isPending && status === 'saved' && 'Saved.'}
        {!isPending && status === 'error' && (error ?? 'Failed to save.')}
        {!isPending && status === 'idle' && (
          <>In-app notifications are always on. These toggles control email only.</>
        )}
      </p>
    </div>
  );
}
