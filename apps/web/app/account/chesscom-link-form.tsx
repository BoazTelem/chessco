'use client';

import { useState, useTransition } from 'react';
import { issueChesscomToken, verifyChesscomToken } from './actions';

type Stage =
  | { kind: 'enter_handle' }
  | { kind: 'awaiting_paste'; handle: string; token: string; profileUrl: string }
  | { kind: 'success' };

export function ChesscomLinkForm() {
  const [stage, setStage] = useState<Stage>({ kind: 'enter_handle' });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (stage.kind === 'success') {
    return <p className="text-sm text-muted-foreground">Linked! Refresh to see your ratings.</p>;
  }

  if (stage.kind === 'awaiting_paste') {
    return (
      <div className="space-y-3 text-sm">
        <ol className="list-decimal space-y-2 pl-5 text-muted-foreground">
          <li>
            Open your profile:{' '}
            <a
              href={stage.profileUrl}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              chess.com/member/{stage.handle}
            </a>
          </li>
          <li>
            Click <span className="text-foreground">Edit Profile</span> → paste this into the{' '}
            <span className="text-foreground">Location</span> field:
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 rounded-md bg-background px-3 py-2 font-mono text-xs text-foreground">
                {stage.token}
              </code>
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(stage.token)}
                className="rounded-md border border-border bg-card px-2 py-1.5 text-xs hover:bg-muted"
              >
                Copy
              </button>
            </div>
          </li>
          <li>Save your chess.com profile.</li>
          <li>Come back and click Verify below.</li>
        </ol>

        {error && <p className="text-destructive">{error}</p>}

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const result = await verifyChesscomToken();
                if (result.ok) setStage({ kind: 'success' });
                else setError(result.error);
              });
            }}
            className="rounded-md bg-accent px-4 py-2 text-xs font-semibold text-accent-foreground transition hover:opacity-90 disabled:opacity-60"
          >
            {pending ? 'Checking…' : 'Verify'}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setStage({ kind: 'enter_handle' });
              setError(null);
            }}
            className="rounded-md border border-border bg-card px-3 py-2 text-xs hover:bg-muted"
          >
            Cancel
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          You can remove the token from your profile after verification.
        </p>
      </div>
    );
  }

  // stage.kind === 'enter_handle'
  return (
    <form
      action={(formData) => {
        setError(null);
        startTransition(async () => {
          const result = await issueChesscomToken(formData);
          if (result.ok) {
            setStage({
              kind: 'awaiting_paste',
              handle: result.handle,
              token: result.token,
              profileUrl: result.profileUrl,
            });
          } else {
            setError(result.error);
          }
        });
      }}
      className="space-y-3"
    >
      <label htmlFor="handle" className="block text-xs font-medium">
        Your Chess.com username
      </label>
      <input
        id="handle"
        name="handle"
        type="text"
        required
        disabled={pending}
        placeholder="e.g. magnuscarlsen"
        autoComplete="off"
        className="block w-full rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="block w-full rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition hover:opacity-90 disabled:opacity-60"
      >
        {pending ? 'Issuing token…' : 'Continue'}
      </button>
    </form>
  );
}
