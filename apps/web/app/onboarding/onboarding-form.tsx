'use client';

import { useState, useTransition } from 'react';
import { COUNTRIES } from '../(auth)/signup/countries';
import { completeOnboarding } from './actions';

type Initial = {
  username: string;
  displayName: string;
  country: string;
  dateOfBirth: string;
  marketingConsent: boolean;
};

export function OnboardingForm({ initial }: { initial: Initial }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await completeOnboarding(formData);
      if (!result.ok) setError(result.error);
      // On success the action redirects via Next.js, no client-side handling needed.
    });
  }

  return (
    <form action={onSubmit} className="space-y-5">
      <Field
        label="Username"
        id="username"
        hint="3–30 characters. Lowercase letters, numbers, underscore, dash. Public: visible on your profile."
      >
        <input
          id="username"
          name="username"
          type="text"
          required
          minLength={3}
          maxLength={30}
          pattern="[a-z0-9_-]+"
          defaultValue={initial.username}
          disabled={pending}
          placeholder="e.g. boaz_t"
          className={inputClass}
        />
      </Field>

      <Field
        label="Display name"
        id="display_name"
        hint="Shown on prep reports, challenges, and the leaderboard."
      >
        <input
          id="display_name"
          name="display_name"
          type="text"
          required
          maxLength={60}
          defaultValue={initial.displayName}
          disabled={pending}
          placeholder="e.g. Boaz Telem"
          className={inputClass}
        />
      </Field>

      <Field label="Country" id="country">
        <select
          id="country"
          name="country"
          required
          defaultValue={initial.country}
          disabled={pending}
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
        hint="You must be 18+ to use the paid sparring marketplace. Otherwise the prep features are open."
      >
        <input
          id="date_of_birth"
          name="date_of_birth"
          type="date"
          required
          defaultValue={initial.dateOfBirth}
          disabled={pending}
          className={inputClass}
        />
      </Field>

      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          name="marketing_consent"
          defaultChecked={initial.marketingConsent}
          disabled={pending}
          className="mt-0.5 h-4 w-4 rounded border-border bg-background text-accent focus:ring-accent focus:ring-offset-0"
        />
        <span className="text-muted-foreground">
          Send me occasional updates about new features and chess tips. You can opt out anytime.
        </span>
      </label>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <button
        type="submit"
        disabled={pending}
        className="block w-full rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition hover:opacity-90 disabled:opacity-60"
      >
        {pending ? 'Saving…' : 'Continue'}
      </button>
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
