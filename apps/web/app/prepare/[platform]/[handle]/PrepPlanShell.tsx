'use client';

/**
 * Client-side shell for the Prep Plan flow. Lives between the server
 * page (which knows the opponent) and the two stateful pieces:
 *   - MyHandlePicker: captures the user's own handle into localStorage
 *   - CorrelationSection: runs the Phase 4-5 engine once we have both
 *
 * URL params (?me=&mePlatform=) take precedence over localStorage so
 * shareable prep links keep working. Once we land user→handle linking
 * at the auth/profile layer, this shell can be simplified.
 */
import { useEffect, useMemo, useState } from 'react';
import { CorrelationSection } from './CorrelationSection';
import { MyHandlePicker, loadStoredHandle, type MyHandle } from './MyHandlePicker';
import type { Platform } from '@/lib/prepare/types';

interface Props {
  oppPlatform: Platform;
  oppHandle: string;
  /** From URL `?me=`: overrides localStorage when present. */
  urlMeHandle: string | null;
  /** From URL `?mePlatform=`: overrides localStorage when present. */
  urlMePlatform: Platform | null;
  /** Drives the "sign in to see AI brief" hint: /explain requires auth. */
  signedIn: boolean;
}

export function PrepPlanShell({
  oppPlatform,
  oppHandle,
  urlMeHandle,
  urlMePlatform,
  signedIn,
}: Props) {
  // Memoize so the useEffect dep below doesn't tick on every render: the
  // object identity would otherwise re-trigger localStorage hydration.
  const urlHandle = useMemo<MyHandle | null>(
    () => (urlMeHandle && urlMePlatform ? { handle: urlMeHandle, platform: urlMePlatform } : null),
    [urlMeHandle, urlMePlatform],
  );
  const [me, setMe] = useState<MyHandle | null>(urlHandle);
  const [hydrated, setHydrated] = useState(urlHandle !== null);

  // On mount, hydrate from localStorage if URL params didn't already provide me.
  useEffect(() => {
    if (urlHandle) {
      setMe(urlHandle);
      setHydrated(true);
      return;
    }
    const stored = loadStoredHandle();
    if (stored) setMe(stored);
    setHydrated(true);
  }, [urlHandle]);

  return (
    <section className="space-y-3">
      <MyHandlePicker initial={me} onChange={setMe} />
      {!signedIn && me ? (
        <p className="text-xs text-muted-foreground">
          Sign in to unlock the AI prep brief. The raw correlation panel renders for everyone.
        </p>
      ) : null}
      {hydrated && me ? (
        <CorrelationSection
          oppPlatform={oppPlatform}
          oppHandle={oppHandle}
          mePlatform={me.platform}
          meHandle={me.handle}
          explainEnabled={signedIn}
        />
      ) : null}
    </section>
  );
}
