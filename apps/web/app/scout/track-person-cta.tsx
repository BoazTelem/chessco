'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { countryFlag, countryName } from '@/lib/scout/countries';

/**
 * "No match? Track this person anyway →" CTA on /scout empty-state.
 *
 * Cold-tail fallback (plan: for-the-risks-we-quiet-lobster.md, Workstream A):
 * when FIDE/ICF/USCF don't have the player, the user supplies an estimated
 * rating (±band) and optional title so Stage 2 candidate scoring still has
 * a rating signal to discriminate online accounts. Rating fields are
 * optional — pure name+country still works for users who don't know.
 *
 * Auth-gated: signed-out users see a sign-in prompt instead of the form.
 */

const TITLES = ['NM', 'CM', 'FM', 'IM', 'GM', 'WCM', 'WFM', 'WIM', 'WGM'] as const;
type Title = (typeof TITLES)[number];

const BANDS = [50, 100, 200] as const;
const DEFAULT_BAND = 100;

export function TrackPersonCTA({
  name,
  country,
  signedIn,
  nextPath,
}: {
  name: string;
  country: string | null;
  signedIn: boolean;
  nextPath: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ratingInput, setRatingInput] = useState('');
  const [band, setBand] = useState<number>(DEFAULT_BAND);
  const [title, setTitle] = useState<Title | ''>('');

  const flag = countryFlag(country);
  const where = country ? `${flag} ${countryName(country)}` : 'any country';

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    // Optional rating: blank input means "no rating signal", which is fine.
    let ratingEstimate: number | null = null;
    if (ratingInput.trim().length > 0) {
      const r = Number(ratingInput);
      if (!Number.isFinite(r) || r < 100 || r > 3500) {
        setError('Rating must be a number between 100 and 3500 (leave blank if unknown).');
        setLoading(false);
        return;
      }
      ratingEstimate = Math.round(r);
    }

    try {
      const body: Record<string, unknown> = { name, country };
      if (ratingEstimate != null) {
        body.rating_estimate = ratingEstimate;
        body.rating_band = band;
      }
      if (title) body.title = title;

      const res = await fetch('/api/ad-hoc-player', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
      const { id } = (await res.json()) as { id: string };
      router.push(`/p/adhoc/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'request failed');
      setLoading(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <p className="text-center text-sm">
        No exact match for <span className="font-medium">&ldquo;{name}&rdquo;</span> in {where}.
      </p>
      <p className="mt-2 text-center text-xs text-muted-foreground">
        Track this person anyway — give what you know about their rating and AI will find their
        online accounts. Identified handles persist for future searches.
      </p>

      {!signedIn ? (
        <div className="mt-4 text-center">
          <Link
            href={`/login?next=${encodeURIComponent(nextPath)}`}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground hover:opacity-90"
          >
            Sign in to track this person →
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="mt-5 space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
            <div>
              <label
                htmlFor="rating-estimate"
                className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                Estimated rating
              </label>
              <input
                id="rating-estimate"
                type="number"
                inputMode="numeric"
                value={ratingInput}
                onChange={(e) => setRatingInput(e.target.value)}
                disabled={loading}
                min={100}
                max={3500}
                placeholder="e.g. 1900"
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
              />
              <p className="mt-1 text-[10px] text-muted-foreground">
                1900 league player? Enter 1900. National Master? ~2200. Leave blank if unknown.
              </p>
            </div>
            <div>
              <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Confidence band
              </span>
              <div className="mt-1 inline-flex rounded-md border border-border bg-background p-0.5">
                {BANDS.map((b) => (
                  <button
                    key={b}
                    type="button"
                    onClick={() => setBand(b)}
                    disabled={loading || ratingInput.trim().length === 0}
                    className={`rounded-sm px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
                      band === b
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    aria-pressed={band === b}
                  >
                    ±{b}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground">
                Wider band = more candidates surfaced.
              </p>
            </div>
          </div>

          <div>
            <label
              htmlFor="track-title"
              className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
            >
              Title (optional)
            </label>
            <select
              id="track-title"
              value={title}
              onChange={(e) => setTitle(e.target.value as Title | '')}
              disabled={loading}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50 sm:w-auto"
            >
              <option value="">(none)</option>
              <optgroup label="Open">
                <option value="NM">NM — National Master</option>
                <option value="CM">CM — Candidate Master</option>
                <option value="FM">FM — FIDE Master</option>
                <option value="IM">IM — International Master</option>
                <option value="GM">GM — Grandmaster</option>
              </optgroup>
              <optgroup label="Women's">
                <option value="WCM">WCM</option>
                <option value="WFM">WFM</option>
                <option value="WIM">WIM</option>
                <option value="WGM">WGM</option>
              </optgroup>
            </select>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
            <p className="text-[11px] text-muted-foreground">
              We&apos;ll create a profile page and run AI identification against Lichess +
              chess.com.
            </p>
            <button
              type="submit"
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground hover:opacity-90 disabled:opacity-50"
            >
              {loading ? 'Creating…' : `Track ${name} →`}
            </button>
          </div>
          {error && <p className="text-xs text-rose-500">{error}</p>}
        </form>
      )}
    </div>
  );
}
