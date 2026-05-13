'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { PositionEditor } from './PositionEditor';
import { STANDARD_START_FEN } from '@/lib/practice/fen';

const TIME_CONTROLS: Array<{
  tc: string;
  tclass: 'bullet' | 'blitz' | 'rapid' | 'classical';
  label: string;
}> = [
  { tc: '1+0', tclass: 'bullet', label: '1+0 bullet' },
  { tc: '3+0', tclass: 'blitz', label: '3+0 blitz' },
  { tc: '3+2', tclass: 'blitz', label: '3+2 blitz' },
  { tc: '5+0', tclass: 'blitz', label: '5+0 blitz' },
  { tc: '10+0', tclass: 'rapid', label: '10+0 rapid' },
  { tc: '15+10', tclass: 'rapid', label: '15+10 rapid' },
  { tc: '30+0', tclass: 'classical', label: '30+0 classical' },
];

type SideChoice = 'w' | 'b' | 'random';

export function CreatePositionForm({ walletAvailableCents }: { walletAvailableCents: number }) {
  const router = useRouter();
  const [fen, setFen] = useState(STANDARD_START_FEN);
  const [fenOk, setFenOk] = useState(true);
  const [fenError, setFenError] = useState<string | null>(null);
  const [tc, setTc] = useState(TIME_CONTROLS[3]!); // 5+0 default
  const [side, setSide] = useState<SideChoice>('random');
  const [feeUsd, setFeeUsd] = useState(2);
  const [games, setGames] = useState(1);
  const [ratingMin, setRatingMin] = useState<string>('');
  const [ratingMax, setRatingMax] = useState<string>('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totalCents = Math.round(feeUsd * 100) * games;
  const insufficient = totalCents > walletAvailableCents;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    if (!fenOk) {
      setError(fenError ?? 'Position is invalid.');
      return;
    }
    if (insufficient) {
      setError('Wallet balance is too low. Add funds or reduce the fee.');
      return;
    }

    const body = {
      fen,
      pgnPrefix: null,
      creatorColor: side === 'random' ? null : side,
      timeControl: tc.tc,
      timeClass: tc.tclass,
      feeCents: Math.round(feeUsd * 100),
      gamesRequested: games,
      ratingMin: ratingMin ? Number(ratingMin) : null,
      ratingMax: ratingMax ? Number(ratingMax) : null,
      notes: notes.trim() || null,
    };

    setSubmitting(true);
    try {
      const res = await fetch('/api/practice/challenges', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? 'Failed to publish challenge.');
        setSubmitting(false);
        return;
      }
      router.push('/practice');
      router.refresh();
    } catch {
      setError('Network error. Try again.');
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Position
        </h2>
        <PositionEditor
          initialFen={fen}
          onChange={(next, ok, reason) => {
            setFen(next);
            setFenOk(ok);
            setFenError(reason ?? null);
          }}
        />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Time control
        </h2>
        <div className="flex flex-wrap gap-2">
          {TIME_CONTROLS.map((t) => (
            <button
              key={t.tc}
              type="button"
              onClick={() => setTc(t)}
              className={`rounded-full border px-3 py-1 text-xs ${
                tc.tc === t.tc
                  ? 'border-accent bg-accent text-accent-foreground'
                  : 'border-border bg-background hover:bg-muted'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </section>

      <section className="grid gap-6 md:grid-cols-2">
        <div>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            You play as
          </h2>
          <div className="flex gap-2">
            {(
              [
                { v: 'w', label: 'White' },
                { v: 'b', label: 'Black' },
                { v: 'random', label: 'Random' },
              ] as Array<{ v: SideChoice; label: string }>
            ).map((opt) => (
              <button
                key={opt.v}
                type="button"
                onClick={() => setSide(opt.v)}
                className={`flex-1 rounded-md border px-3 py-1.5 text-sm ${
                  side === opt.v
                    ? 'border-accent bg-accent text-accent-foreground'
                    : 'border-border bg-background hover:bg-muted'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Games to publish
          </h2>
          <div className="flex gap-2">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setGames(n)}
                className={`h-9 w-9 rounded-md border text-sm ${
                  games === n
                    ? 'border-accent bg-accent text-accent-foreground'
                    : 'border-border bg-background hover:bg-muted'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <div>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Fee per game (USD)
          </h2>
          <div className="flex items-center gap-2">
            <span className="text-lg">$</span>
            <input
              type="number"
              min={0.5}
              max={500}
              step={0.5}
              value={feeUsd}
              onChange={(e) => setFeeUsd(Math.max(0.5, Number(e.target.value) || 0))}
              className="w-24 rounded-md border border-border bg-background px-2 py-1.5 text-base"
            />
            <span className="text-xs text-muted-foreground">
              total ${(totalCents / 100).toFixed(2)}
            </span>
          </div>
          {insufficient && (
            <p className="mt-2 text-xs text-destructive">
              Wallet has ${(walletAvailableCents / 100).toFixed(2)} — not enough for the full
              deposit.
            </p>
          )}
        </div>

        <div>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Opponent rating range (optional)
          </h2>
          <div className="flex items-center gap-2">
            <input
              type="number"
              placeholder="min"
              min={0}
              max={3500}
              value={ratingMin}
              onChange={(e) => setRatingMin(e.target.value)}
              className="w-24 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <input
              type="number"
              placeholder="max"
              min={0}
              max={3500}
              value={ratingMax}
              onChange={(e) => setRatingMax(e.target.value)}
              className="w-24 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            />
          </div>
        </div>
      </section>

      <section>
        <label className="mb-2 block text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Notes for opponent (optional)
        </label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          maxLength={500}
          placeholder="e.g. play the most principled lines, no quick draws"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
      </section>

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting || !fenOk || insufficient}
          className="rounded-md bg-accent px-6 py-2 text-sm font-semibold text-accent-foreground disabled:opacity-60"
        >
          {submitting ? 'Publishing…' : `Publish — $${(totalCents / 100).toFixed(2)}`}
        </button>
        <span className="text-xs text-muted-foreground">
          The deposit is refunded if no one accepts and the challenge expires.
        </span>
      </div>
    </form>
  );
}
