'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LeakCard, type LeakDto } from './LeakCard';

type ReportStatus = 'pending' | 'data_pending' | 'building' | 'ready' | 'failed';

interface ReportPayload {
  status: ReportStatus;
  error?: string | null;
  generated_at?: string;
  leaks?: {
    white: LeakDto[];
    black: LeakDto[];
  };
}

interface Props {
  signedIn: boolean;
  platform: 'lichess' | 'chess.com';
  handle: string;
  loginHref: string;
}

const POLL_INTERVAL_MS = 5000;

export function PersonalizedLeaks({ signedIn, platform, handle, loginHref }: Props) {
  const [reportId, setReportId] = useState<string | null>(null);
  const [payload, setPayload] = useState<ReportPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'white' | 'black'>('white');
  const [unlocking, setUnlocking] = useState<string | null>(null);
  const [insufficientCredits, setInsufficientCredits] = useState(false);

  const handleNormalized = useMemo(() => handle.trim().toLowerCase(), [handle]);

  // Create or reuse the report once on mount (only when signed in). The
  // POST response gives us only an id + a hint status; the polling effect
  // is responsible for fetching the full payload (including leaks_json).
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/prepare/reports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform, handle: handleNormalized }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          if (!cancelled) setError(body.error ?? `report_create_${res.status}`);
          return;
        }
        const body = (await res.json()) as { id: string; status: ReportStatus };
        if (cancelled) return;
        setReportId(body.id);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signedIn, platform, handleNormalized]);

  // Always do at least one GET once we have a report id, then poll while
  // the status is non-terminal. Reload-with-existing-ready-report case
  // depends on this firing regardless of any prior payload state.
  useEffect(() => {
    if (!reportId) return;
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      try {
        const res = await fetch(`/api/prepare/reports/${reportId}`, { cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json()) as ReportPayload;
        if (cancelled) return;
        setPayload(body);
        if (body.status === 'ready' || body.status === 'failed') {
          if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
          }
        }
      } catch {
        // swallow; will retry on next interval
      }
    };

    void tick();
    intervalId = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [reportId]);

  const onUnlock = useCallback(
    async (fingerprint: string) => {
      if (!reportId) return;
      setUnlocking(fingerprint);
      setInsufficientCredits(false);
      try {
        const res = await fetch(`/api/prepare/reports/${reportId}/leaks/${fingerprint}/reveal`, {
          method: 'POST',
        });
        if (res.status === 402) {
          setInsufficientCredits(true);
          return;
        }
        if (!res.ok) {
          setError(`unlock_failed_${res.status}`);
          return;
        }
        const body = (await res.json()) as { leak: LeakDto };
        setPayload((prev) => {
          if (!prev?.leaks) return prev;
          const replace = (list: LeakDto[]) =>
            list.map((l) => (l.fingerprint === fingerprint ? body.leak : l));
          return {
            ...prev,
            leaks: {
              white: replace(prev.leaks.white),
              black: replace(prev.leaks.black),
            },
          };
        });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setUnlocking(null);
      }
    },
    [reportId],
  );

  if (!signedIn) {
    return (
      <section className="mx-auto w-full max-w-3xl rounded-xl border border-border bg-card p-6">
        <h2 className="font-display text-xl font-semibold">Personalized leaks</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Positions where {handle} has played poorly that you can reach from your own repertoire —
          plus surprise lines to catch them off-guard, and where you tend to slip up against their
          repertoire.
        </p>
        <div className="mt-4 flex flex-col items-start gap-3 rounded-md border border-accent/30 bg-accent/5 px-4 py-4">
          <p className="text-sm text-foreground">
            Sign in to correlate leaks with your repertoire.
          </p>
          <Link
            href={loginHref}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground transition hover:opacity-90"
          >
            Sign in
          </Link>
        </div>
      </section>
    );
  }

  const renderBody = () => {
    if (error) {
      return <p className="text-sm text-destructive">Could not load report: {error}</p>;
    }
    if (!payload) {
      return <p className="text-sm text-muted-foreground">Preparing your report…</p>;
    }
    if (
      payload.status === 'pending' ||
      payload.status === 'data_pending' ||
      payload.status === 'building'
    ) {
      return (
        <div className="rounded-md border border-dashed border-border bg-background/60 px-4 py-6 text-center text-xs uppercase tracking-wider text-muted-foreground">
          Indexing {handle}&rsquo;s recent games · this can take a couple of minutes
        </div>
      );
    }
    if (payload.status === 'failed') {
      let helpful = payload.error ?? 'unknown';
      if (helpful === 'no_linked_accounts') helpful = 'Link a chess.com or Lichess account first.';
      if (helpful === 'opponent_not_in_corpus')
        helpful = `We have not crawled ${handle}’s games yet. Try again later.`;
      return <p className="text-sm text-destructive">Report failed: {helpful}</p>;
    }
    if (payload.status === 'ready' && payload.leaks) {
      const list = tab === 'white' ? payload.leaks.white : payload.leaks.black;
      if (list.length === 0) {
        return (
          <p className="text-sm text-muted-foreground">
            No leaks found for you-as-{tab}. Try the other tab.
          </p>
        );
      }
      const opp = list.filter((l) => l.kind === 'personalized' || l.kind === 'surprise');
      const own = list.filter((l) => l.kind === 'own');
      return (
        <div className="space-y-5">
          {opp.length > 0 && (
            <div className="space-y-3">
              <p className="text-[11px] uppercase tracking-[0.15em] text-accent">
                Their weaknesses you can exploit
              </p>
              {opp.map((leak) => (
                <LeakCard
                  key={leak.fingerprint}
                  leak={leak}
                  onUnlock={onUnlock}
                  isUnlocking={unlocking === leak.fingerprint}
                />
              ))}
            </div>
          )}
          {own.length > 0 && (
            <div className="space-y-3">
              <p className="text-[11px] uppercase tracking-[0.15em] text-destructive">
                Where you slip up vs their repertoire
              </p>
              {own.map((leak) => (
                <LeakCard
                  key={leak.fingerprint}
                  leak={leak}
                  onUnlock={onUnlock}
                  isUnlocking={unlocking === leak.fingerprint}
                />
              ))}
            </div>
          )}
        </div>
      );
    }
    return null;
  };

  return (
    <section className="mx-auto w-full max-w-3xl rounded-xl border border-border bg-card p-6">
      <h2 className="font-display text-xl font-semibold">Personalized leaks</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Positions where {handle} has played poorly that you can reach from your own repertoire —
        plus surprise lines to catch them off-guard, and where you tend to slip up against their
        repertoire.
      </p>

      {payload?.status === 'ready' && (
        <div className="mt-4 flex gap-2 text-xs">
          <button
            type="button"
            onClick={() => setTab('white')}
            className={`rounded-md px-3 py-1.5 font-semibold transition ${
              tab === 'white'
                ? 'bg-accent text-accent-foreground'
                : 'border border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            You play White
          </button>
          <button
            type="button"
            onClick={() => setTab('black')}
            className={`rounded-md px-3 py-1.5 font-semibold transition ${
              tab === 'black'
                ? 'bg-accent text-accent-foreground'
                : 'border border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            You play Black
          </button>
        </div>
      )}

      {insufficientCredits && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          Not enough credits to unlock this leak. Link another account or invite friends to earn
          more.
        </div>
      )}

      <div className="mt-4">{renderBody()}</div>
    </section>
  );
}
