'use client';

import { useState, useTransition } from 'react';
import { sendMagicLink } from '../actions';

export function LoginForm() {
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<
    { kind: 'idle' } | { kind: 'error'; message: string } | { kind: 'sent'; email: string }
  >({ kind: 'idle' });

  async function onSubmit(formData: FormData) {
    setStatus({ kind: 'idle' });
    const email = String(formData.get('email') ?? '');
    startTransition(async () => {
      const result = await sendMagicLink(formData);
      if (result.ok) {
        setStatus({ kind: 'sent', email });
      } else {
        setStatus({ kind: 'error', message: result.error });
      }
    });
  }

  if (status.kind === 'sent') {
    return (
      <div className="rounded-lg border border-accent/30 bg-accent/5 px-4 py-5 text-sm">
        <p className="font-medium text-foreground">Check your email.</p>
        <p className="mt-1 text-muted-foreground">
          We sent a sign-in link to <span className="text-foreground">{status.email}</span>. It
          expires in 1 hour.
        </p>
      </div>
    );
  }

  return (
    <form action={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="email" className="text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          disabled={pending}
          placeholder="you@example.com"
          className="block w-full rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
        />
      </div>

      {status.kind === 'error' && <p className="text-sm text-destructive">{status.message}</p>}

      <button
        type="submit"
        disabled={pending}
        className="block w-full rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition hover:opacity-90 disabled:opacity-60"
      >
        {pending ? 'Sending…' : 'Send magic link'}
      </button>
    </form>
  );
}
