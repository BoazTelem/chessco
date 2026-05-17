'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

export function InvitationActions({
  challengeId,
  invitationId,
}: {
  challengeId: string;
  invitationId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [resolved, setResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function accept() {
    startTransition(async () => {
      setError(null);
      try {
        const res = await fetch(`/api/practice/challenges/${challengeId}/accept`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ invitation_id: invitationId }),
        });
        const data = (await res.json()) as { matchId?: string; error?: string };
        if (!res.ok || !data.matchId) throw new Error(data.error ?? `HTTP ${res.status}`);
        router.push(`/practice/g/${data.matchId}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  function decline() {
    startTransition(async () => {
      setError(null);
      try {
        const res = await fetch(`/api/sparring/invitations/${invitationId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'decline' }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(data?.error ?? `HTTP ${res.status}`);
        }
        setResolved(true);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  if (resolved) {
    return <span className="text-xs text-muted-foreground">Declined</span>;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={accept}
          disabled={pending}
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-500/20 disabled:opacity-50"
        >
          Accept
        </button>
        <button
          type="button"
          onClick={decline}
          disabled={pending}
          className="rounded-md border border-border bg-card px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
        >
          Decline
        </button>
      </div>
      {error ? <p className="max-w-56 text-right text-xs text-red-300">{error}</p> : null}
    </div>
  );
}
