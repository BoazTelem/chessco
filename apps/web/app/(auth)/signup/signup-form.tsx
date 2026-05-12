'use client';

import { useState, useTransition } from 'react';
import { signUp } from '../actions';
import { COUNTRIES } from './countries';

export function SignupForm() {
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<
    { kind: 'idle' } | { kind: 'error'; message: string } | { kind: 'sent' }
  >({ kind: 'idle' });

  async function onSubmit(formData: FormData) {
    setStatus({ kind: 'idle' });
    startTransition(async () => {
      const result = await signUp(formData);
      if (result.ok) {
        setStatus({ kind: 'sent' });
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
          We sent a confirmation link. Click it to finish creating your account.
        </p>
      </div>
    );
  }

  return (
    <form action={onSubmit} className="space-y-4">
      <Field label="Email" id="email">
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          disabled={pending}
          placeholder="you@example.com"
          className={inputClass}
        />
      </Field>

      <Field label="Password" id="password" hint="At least 8 characters.">
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          disabled={pending}
          className={inputClass}
        />
      </Field>

      <Field label="Country" id="country">
        <select
          id="country"
          name="country"
          required
          disabled={pending}
          defaultValue=""
          className={inputClass}
        >
          <option value="" disabled>
            Select a country
          </option>
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Date of birth"
        id="date_of_birth"
        hint="You must be 18+ to use the paid sparring marketplace."
      >
        <input
          id="date_of_birth"
          name="date_of_birth"
          type="date"
          required
          disabled={pending}
          className={inputClass}
        />
      </Field>

      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          name="marketing_consent"
          disabled={pending}
          className="mt-0.5 h-4 w-4 rounded border-border bg-background text-accent focus:ring-accent focus:ring-offset-0"
        />
        <span className="text-muted-foreground">
          Send me occasional updates about new features and chess tips. You can opt out anytime.
        </span>
      </label>

      {status.kind === 'error' && <p className="text-sm text-destructive">{status.message}</p>}

      <button
        type="submit"
        disabled={pending}
        className="block w-full rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition hover:opacity-90 disabled:opacity-60"
      >
        {pending ? 'Creating account…' : 'Create account'}
      </button>

      <p className="text-center text-xs text-muted-foreground">
        By signing up you agree to our Terms of Use and Privacy Policy.
      </p>
    </form>
  );
}

const inputClass =
  'block w-full rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60';

function Field({
  label,
  id,
  hint,
  children,
}: {
  label: string;
  id: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
