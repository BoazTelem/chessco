'use client';

import { useTransition } from 'react';
import { unlinkExternalAccount } from './actions';

export function UnlinkButton({ id, platform }: { id: string; platform: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <form
      action={(fd) =>
        startTransition(async () => {
          await unlinkExternalAccount(fd);
          // Server action revalidates via redirect; we soft-refresh.
          window.location.reload();
        })
      }
    >
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        disabled={pending}
        onClick={(e) => {
          if (!confirm(`Disconnect this ${platform} account from Chessco?`)) {
            e.preventDefault();
          }
        }}
        className="rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-60"
      >
        {pending ? 'Disconnecting…' : 'Disconnect'}
      </button>
    </form>
  );
}
