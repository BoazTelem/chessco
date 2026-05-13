'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { PositionEditor } from './PositionEditor';
import { STANDARD_START_FEN } from '@/lib/practice/fen';
import { COMMON_OPENINGS } from '@/lib/practice/openings';

type TimeClass = 'bullet' | 'blitz' | 'rapid' | 'classical';

interface TimeControl {
  tc: string;
  tclass: TimeClass;
  label: string;
}

const TIME_CONTROLS: TimeControl[] = [
  { tc: '1+0', tclass: 'bullet', label: '1+0 bullet' },
  { tc: '3+0', tclass: 'blitz', label: '3+0 blitz' },
  { tc: '3+2', tclass: 'blitz', label: '3+2 blitz' },
  { tc: '5+0', tclass: 'blitz', label: '5+0 blitz' },
  { tc: '10+0', tclass: 'rapid', label: '10+0 rapid' },
  { tc: '15+10', tclass: 'rapid', label: '15+10 rapid' },
  { tc: '30+0', tclass: 'classical', label: '30+0 classical' },
  { tc: '50+10', tclass: 'classical', label: '50+10 classical' },
  { tc: '90+30', tclass: 'classical', label: '90+30 classical' },
];

/**
 * Classify a custom time control by chess.com's convention: total estimated
 * time = base_seconds + 40 * increment_seconds. Bullet < 2 min, blitz < 10,
 * rapid < 30, otherwise classical.
 */
function classifyCustom(baseMin: number, incSec: number): TimeClass {
  const totalSeconds = baseMin * 60 + 40 * incSec;
  if (totalSeconds < 120) return 'bullet';
  if (totalSeconds < 600) return 'blitz';
  if (totalSeconds < 1800) return 'rapid';
  return 'classical';
}

type SideChoice = 'w' | 'b' | 'random';

interface Props {
  walletAvailableCents: number;
  /** Best-known rating for the user (from linked online accounts or Chessco skill). */
  userRating: number | null;
}

const DEFAULT_TC_INDEX = 4; // 10+0 rapid — most common online time class
const RATING_BAND_ABOVE = 200; // default opponent ceiling = user rating + 200

export function CreatePositionForm({ walletAvailableCents, userRating }: Props) {
  const router = useRouter();
  const [fen, setFen] = useState(STANDARD_START_FEN);
  const [fenOk, setFenOk] = useState(true);
  const [fenError, setFenError] = useState<string | null>(null);
  const [tc, setTc] = useState(TIME_CONTROLS[DEFAULT_TC_INDEX]!);
  const [customMode, setCustomMode] = useState(false);
  const [customBaseMin, setCustomBaseMin] = useState(20);
  const [customIncSec, setCustomIncSec] = useState(0);
  const [side, setSide] = useState<SideChoice>('random');
  const [feeUsd, setFeeUsd] = useState(0);
  const [games, setGames] = useState(1);
  const [ratingMin, setRatingMin] = useState<string>(userRating != null ? String(userRating) : '');
  const [ratingMax, setRatingMax] = useState<string>(
    userRating != null ? String(userRating + RATING_BAND_ABOVE) : '',
  );
  const [notes, setNotes] = useState('');
  const [openingName, setOpeningName] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totalCents = Math.round(feeUsd * 100) * games;
  const insufficient = totalCents > walletAvailableCents;
  const isFree = totalCents === 0;

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

    const effectiveBase = customMode ? Math.max(1, Math.floor(customBaseMin)) : null;
    const effectiveInc = customMode ? Math.max(0, Math.floor(customIncSec)) : null;
    if (customMode && (effectiveBase === null || effectiveBase < 1)) {
      setError('Custom base time must be at least 1 minute.');
      return;
    }

    const effectiveTcStr = customMode ? `${effectiveBase}+${effectiveInc}` : tc.tc;
    const effectiveTcClass = customMode ? classifyCustom(effectiveBase!, effectiveInc!) : tc.tclass;

    const body = {
      fen,
      pgnPrefix: null,
      creatorColor: side === 'random' ? null : side,
      timeControl: effectiveTcStr,
      timeClass: effectiveTcClass,
      feeCents: Math.round(feeUsd * 100),
      gamesRequested: games,
      ratingMin: ratingMin ? Number(ratingMin) : null,
      ratingMax: ratingMax ? Number(ratingMax) : null,
      notes: notes.trim() || null,
      openingName: openingName.trim() || null,
      anonymous,
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
              onClick={() => {
                setTc(t);
                setCustomMode(false);
              }}
              className={`rounded-full border px-3 py-1 text-xs ${
                !customMode && tc.tc === t.tc
                  ? 'border-accent bg-accent text-accent-foreground'
                  : 'border-border bg-background hover:bg-muted'
              }`}
            >
              {t.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setCustomMode(true)}
            className={`rounded-full border px-3 py-1 text-xs ${
              customMode
                ? 'border-accent bg-accent text-accent-foreground'
                : 'border-border bg-background hover:bg-muted'
            }`}
          >
            Custom
          </button>
        </div>
        {customMode && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={180}
                step={1}
                value={customBaseMin}
                onChange={(e) =>
                  setCustomBaseMin(Math.max(1, Math.min(180, Number(e.target.value) || 0)))
                }
                className="w-20 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              />
              <span className="text-xs text-muted-foreground">minutes</span>
            </label>
            <span className="text-muted-foreground">+</span>
            <label className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={60}
                step={1}
                value={customIncSec}
                onChange={(e) =>
                  setCustomIncSec(Math.max(0, Math.min(60, Number(e.target.value) || 0)))
                }
                className="w-20 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              />
              <span className="text-xs text-muted-foreground">
                seconds increment ·{' '}
                <span className="text-foreground">
                  {classifyCustom(customBaseMin, customIncSec)}
                </span>
              </span>
            </label>
          </div>
        )}
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
              min={0}
              max={500}
              step={0.5}
              value={feeUsd}
              onChange={(e) => setFeeUsd(Math.max(0, Number(e.target.value) || 0))}
              className="w-24 rounded-md border border-border bg-background px-2 py-1.5 text-base"
            />
            <span className="text-xs text-muted-foreground">
              {isFree ? 'free game' : `total $${(totalCents / 100).toFixed(2)}`}
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
        <label
          htmlFor="opening-input"
          className="mb-2 block text-sm font-semibold uppercase tracking-wider text-muted-foreground"
        >
          Opening (optional)
        </label>
        <input
          id="opening-input"
          type="text"
          list="practice-openings"
          value={openingName}
          onChange={(e) => setOpeningName(e.target.value)}
          maxLength={80}
          placeholder="e.g. Sicilian Defense, Lucena position"
          className="w-full max-w-md rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
        <datalist id="practice-openings">
          {COMMON_OPENINGS.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Helps people filter the lobby by what they want to practice.
        </p>
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

      <section>
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card p-3">
          <input
            type="checkbox"
            checked={anonymous}
            onChange={(e) => setAnonymous(e.target.checked)}
            className="mt-0.5 h-4 w-4"
          />
          <div>
            <p className="text-sm font-medium">Publish anonymously</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Hide your name. Your rating still shows so opponents can gauge the matchup. Uncheck to
              let people open your profile and see your games.
            </p>
          </div>
        </label>
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
          {submitting
            ? 'Publishing…'
            : isFree
              ? 'Publish (free)'
              : `Publish — $${(totalCents / 100).toFixed(2)}`}
        </button>
        <span className="text-xs text-muted-foreground">
          {isFree
            ? 'No fee — opponents play for fun.'
            : 'The deposit is refunded if no one accepts and the challenge expires.'}
        </span>
      </div>
    </form>
  );
}
