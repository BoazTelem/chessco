'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';

type Platform = 'chess.com' | 'lichess';

type Status = 'idle' | 'verifying' | 'error';

export function PrepareEntryForm() {
  const id = useId();
  const router = useRouter();
  const [handle, setHandle] = useState('');
  const [platform, setPlatform] = useState<Platform>('chess.com');
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = handle.trim();
    if (!trimmed) {
      setErrorMsg('Enter a handle.');
      setStatus('error');
      return;
    }
    setStatus('verifying');
    setErrorMsg('');
    try {
      const res = await fetch('/api/prepare/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: trimmed, platform }),
      });
      if (res.status === 404) {
        setErrorMsg(`We couldn't find ${trimmed} on ${platform}. Check the spelling.`);
        setStatus('error');
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setErrorMsg(body.error ?? 'Something went wrong. Try again.');
        setStatus('error');
        return;
      }
      const data = (await res.json()) as { handle: string };
      const platformSlug = platform === 'chess.com' ? 'chesscom' : 'lichess';
      router.push(`/prepare/${platformSlug}/${encodeURIComponent(data.handle)}`);
    } catch {
      setErrorMsg('Network error — try again.');
      setStatus('error');
    }
  }

  return (
    <form onSubmit={onSubmit} className="w-full space-y-3">
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
        <label htmlFor={`${id}-platform`} className="sr-only">
          Platform
        </label>
        <select
          id={`${id}-platform`}
          value={platform}
          onChange={(e) => setPlatform(e.target.value as Platform)}
          className="rounded-md border border-border bg-background px-2 py-2 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <option value="chess.com">chess.com</option>
          <option value="lichess">Lichess</option>
        </select>

        <label htmlFor={`${id}-handle`} className="sr-only">
          Handle
        </label>
        <input
          id={`${id}-handle`}
          type="text"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="Handle — e.g. magnuscarlsen"
          className="block w-full rounded-md border border-border bg-background px-3 py-2 text-base placeholder:text-muted-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        />

        <button
          type="submit"
          disabled={status === 'verifying'}
          className="rounded-md bg-accent px-5 py-2 text-sm font-semibold text-accent-foreground transition hover:opacity-90 disabled:opacity-60"
        >
          {status === 'verifying' ? 'Checking…' : 'Open prep →'}
        </button>
      </div>
      {status === 'error' ? (
        <p className="text-left text-sm text-destructive" role="alert">
          {errorMsg}
        </p>
      ) : null}
    </form>
  );
}
