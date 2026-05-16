'use client';

/**
 * Lightweight "your handle" picker for the Prep Plan flow. Persists to
 * localStorage so the user only enters it once per browser. Drives the
 * CorrelationSection when no `?me=&mePlatform=` URL params are present.
 *
 * Deliberately NOT in the auth/profile layer — that's a larger schema
 * + UX project. This is the wedge that makes Phase 4-5 reachable for a
 * real user today; the formal user→handle linking work supersedes it
 * later (e.g. captured at signup, stored on the profile).
 */
import { useCallback, useEffect, useState } from 'react';
import type { Platform } from '@/lib/prepare/types';

const STORAGE_KEY_HANDLE = 'chessco:prep:my_handle';
const STORAGE_KEY_PLATFORM = 'chessco:prep:my_platform';

export interface MyHandle {
  handle: string;
  platform: Platform;
}

export function loadStoredHandle(): MyHandle | null {
  if (typeof window === 'undefined') return null;
  try {
    const handle = window.localStorage.getItem(STORAGE_KEY_HANDLE);
    const platform = window.localStorage.getItem(STORAGE_KEY_PLATFORM);
    if (!handle || (platform !== 'chess.com' && platform !== 'lichess')) return null;
    return { handle, platform };
  } catch {
    return null;
  }
}

function storeHandle(handle: string, platform: Platform): void {
  try {
    window.localStorage.setItem(STORAGE_KEY_HANDLE, handle);
    window.localStorage.setItem(STORAGE_KEY_PLATFORM, platform);
  } catch {
    // Private browsing or quota — silently degrade; the form just won't
    // remember next visit.
  }
}

function clearStoredHandle(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY_HANDLE);
    window.localStorage.removeItem(STORAGE_KEY_PLATFORM);
  } catch {
    // ignore
  }
}

interface Props {
  initial: MyHandle | null;
  onChange: (next: MyHandle | null) => void;
}

export function MyHandlePicker({ initial, onChange }: Props) {
  const [editing, setEditing] = useState(initial === null);
  const [handle, setHandle] = useState(initial?.handle ?? '');
  const [platform, setPlatform] = useState<Platform>(initial?.platform ?? 'chess.com');

  // Re-sync internal state when initial prop changes (e.g. on hydration).
  useEffect(() => {
    setHandle(initial?.handle ?? '');
    setPlatform(initial?.platform ?? 'chess.com');
    setEditing(initial === null);
  }, [initial]);

  const onSave = useCallback(() => {
    const trimmed = handle.trim();
    if (!trimmed) return;
    storeHandle(trimmed, platform);
    onChange({ handle: trimmed, platform });
    setEditing(false);
  }, [handle, platform, onChange]);

  const onClear = useCallback(() => {
    clearStoredHandle();
    setHandle('');
    onChange(null);
    setEditing(true);
  }, [onChange]);

  if (!editing && initial) {
    return (
      <div className="rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
        Playing as <span className="font-semibold text-foreground">{initial.handle}</span> on{' '}
        {initial.platform === 'chess.com' ? 'chess.com' : 'Lichess'} ·{' '}
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-accent hover:underline"
        >
          change
        </button>{' '}
        ·{' '}
        <button type="button" onClick={onClear} className="text-accent hover:underline">
          clear
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-dashed border-accent/40 bg-accent/5 p-4">
      <p className="text-[11px] uppercase tracking-[0.15em] text-accent">
        Set your handle to unlock the prep plan
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        We compare your bucketed repertoire against theirs to surface the lines you should study
        first. Stored in your browser only — not sent to us until you submit.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value as Platform)}
          className="rounded border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value="chess.com">chess.com</option>
          <option value="lichess">lichess</option>
        </select>
        <input
          type="text"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="your handle"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-sm"
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSave();
          }}
        />
        <button
          type="button"
          onClick={onSave}
          disabled={handle.trim().length === 0}
          className="rounded bg-accent px-3 py-1.5 text-sm font-semibold text-accent-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </div>
  );
}
