'use client';

/**
 * InvitePicker — lists currently-online Practice users and lets the viewer
 * send a credit-funded direct invite from the standard starting position with
 * the chosen time control. Reads from the shared presence store fed by
 * PracticePresence (mounted globally). Never opens its own Realtime channel
 * with topic `practice-presence`: `supabase.channel(topic)` returns the
 * existing instance, and adding presence callbacks after subscribe() throws.
 */

import { useMemo, useState } from 'react';
import { usePresence } from '@/lib/practice/presence-store';
import { LowCreditsDialog } from '@/components/credits/LowCreditsDialog';
import { useLowCreditsDialog } from '@/components/credits/useLowCreditsDialog';

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const TIME_CONTROLS = [
  { label: '1+0 Bullet', tc: '1+0', cls: 'bullet' as const },
  { label: '3+0 Blitz', tc: '3+0', cls: 'blitz' as const },
  { label: '5+0 Blitz', tc: '5+0', cls: 'blitz' as const },
  { label: '10+0 Rapid', tc: '10+0', cls: 'rapid' as const },
];

export function InvitePicker({
  currentUserId,
  creditAvailable,
  referralCode,
  referralCreditsEarned,
  referralCreditsCap,
}: {
  currentUserId: string;
  creditAvailable: number;
  referralCode: string;
  referralCreditsEarned: number;
  referralCreditsCap: number;
}) {
  const presence = usePresence();
  const [tcIndex, setTcIndex] = useState(2); // 5+0 Blitz default
  const [pendingForUser, setPendingForUser] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<Set<string>>(new Set());
  const creditsLeft = Math.max(0, creditAvailable - sentTo.size);
  const lowCredits = useLowCreditsDialog();

  const online = useMemo(
    () => presence.filter((u) => u.user_id !== currentUserId),
    [presence, currentUserId],
  );

  const tc = TIME_CONTROLS[tcIndex]!;

  async function sendInvite(targetUserId: string): Promise<void> {
    setError(null);
    if (creditsLeft <= 0) {
      lowCredits.show();
      return;
    }
    setPendingForUser(targetUserId);
    try {
      const res = await fetch('/api/practice/invites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          targetUserId,
          fen: STARTING_FEN,
          timeControl: tc.tc,
          timeClass: tc.cls,
        }),
      });
      if (res.status === 402) {
        lowCredits.show();
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? 'failed to send invite');
      }
      setSentTo((prev) => new Set(prev).add(targetUserId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to send invite');
    } finally {
      setPendingForUser(null);
    }
  }

  const sorted = useMemo(
    () =>
      [...online].sort((a, b) =>
        (a.display_name ?? a.username ?? '').localeCompare(b.display_name ?? b.username ?? ''),
      ),
    [online],
  );

  return (
    <section className="rounded-lg border border-accent/30 bg-accent/5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold">Direct invite</h2>
          <p className="text-xs text-muted-foreground">
            Costs 1 credit from the starting position. The friend you pick gets a notification.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-muted-foreground">Credits: {creditsLeft}</span>
          <label className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Time</span>
            <select
              value={tcIndex}
              onChange={(e) => setTcIndex(Number(e.target.value))}
              className="rounded-md border border-border bg-background px-2 py-1"
            >
              {TIME_CONTROLS.map((t, i) => (
                <option key={t.tc} value={i}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {error && (
        <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      )}

      <LowCreditsDialog
        open={lowCredits.open}
        onClose={lowCredits.hide}
        referralCode={referralCode}
        referralCreditsEarned={referralCreditsEarned}
        referralCreditsCap={referralCreditsCap}
      />

      <div className="mt-3 max-h-64 overflow-auto rounded-md border border-border bg-background">
        {sorted.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">
            No other players online right now.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {sorted.map((u) => {
              const name = u.display_name ?? u.username ?? u.user_id.slice(0, 8);
              const isPending = pendingForUser === u.user_id;
              const isSent = sentTo.has(u.user_id);
              return (
                <li
                  key={u.user_id}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <div className="flex items-center gap-2">
                    <span className="inline-block h-2 w-2 rounded-full bg-accent" />
                    <span>{name}</span>
                    {u.username && u.username !== name && (
                      <span className="text-xs text-muted-foreground">@{u.username}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => sendInvite(u.user_id)}
                    disabled={isPending || isSent || creditsLeft <= 0}
                    className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-accent-foreground disabled:opacity-60"
                  >
                    {isSent ? 'Invite sent' : isPending ? 'Sending…' : `Challenge ${tc.tc}`}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
