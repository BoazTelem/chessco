'use client';

import { useTransition } from 'react';
import { startLichessLink } from './actions';

export function LichessLinkButton() {
  const [pending, startTransition] = useTransition();

  return (
    <form
      action={() =>
        startTransition(async () => {
          await startLichessLink();
        })
      }
    >
      <button
        type="submit"
        disabled={pending}
        className="block w-full rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition hover:opacity-90 disabled:opacity-60"
      >
        {pending ? 'Redirecting to Lichess…' : 'Connect Lichess'}
      </button>
      <p className="mt-2 text-xs text-muted-foreground">
        You&apos;ll authorize via Lichess and come back automatically. Read-only access.
      </p>
    </form>
  );
}
