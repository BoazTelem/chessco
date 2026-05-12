'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Paste-a-PGN form. POSTs sample_pgn to /api/identify, redirects to
 * /scout/match/[query_id]. AI stylometric matching runs in ~1s server-
 * side; we show an inline loading state rather than a polling page since
 * Stage 3 V0 fits comfortably inside a normal HTTP response.
 *
 * UX: one labeled textarea per game with an explicit "+ Add another
 * game" button. Users don't intuit the blank-line PGN divider, so the
 * slot model makes "paste 10 games" obvious. On submit we join slots
 * with \n\n — that is exactly what splitGames() expects, so no server
 * change is required. A multi-game paste into a single slot still
 * parses correctly (the server splitter handles either shape).
 */
export interface SampleGameFormProps {
  federationPlayerId?: string;
  adHocPlayerId?: string;
  subjectLabel?: string;
}

const INITIAL_SLOT_COUNT = 1;

export function SampleGameForm({
  federationPlayerId,
  adHocPlayerId,
  subjectLabel,
}: SampleGameFormProps = {}) {
  const router = useRouter();
  const [pgns, setPgns] = useState<string[]>(() => Array(INITIAL_SLOT_COUNT).fill(''));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastRef = useRef<HTMLTextAreaElement | null>(null);

  const nonEmptyCount = pgns.filter((p) => p.trim().length > 0).length;

  function updateSlot(i: number, val: string) {
    setPgns((cur) => cur.map((p, idx) => (idx === i ? val : p)));
  }
  function addSlot() {
    setPgns((cur) => [...cur, '']);
    // Focus the new slot on the next tick.
    setTimeout(() => lastRef.current?.focus(), 0);
  }
  function removeSlot(i: number) {
    setPgns((cur) => (cur.length === 1 ? cur : cur.filter((_, idx) => idx !== i)));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const joined = pgns
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .join('\n\n');
    if (!joined) {
      setError('Paste at least one PGN.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { sample_pgn: joined };
      if (federationPlayerId) body.federation_player_id = federationPlayerId;
      if (adHocPlayerId) body.ad_hoc_player_id = adHocPlayerId;
      const res = await fetch('/api/identify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
      const { query_id } = (await res.json()) as { query_id: string };
      router.push(`/scout/match/${query_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'request failed');
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div>
        <label className="text-sm font-medium">
          Paste 10+ PGN games of{' '}
          {subjectLabel ? <strong>{subjectLabel}</strong> : 'the target player'}
        </label>
        <p className="mt-1 text-xs text-muted-foreground">
          AI matches play patterns against ~1,400 indexed Lichess handles. The target&apos;s real
          handle doesn&apos;t need to resemble their name — works on opening repertoire, time class,
          and opponent-rating signal.
        </p>
      </div>

      <div className="space-y-2">
        {pgns.map((pgn, i) => (
          <div
            key={i}
            className="overflow-hidden rounded-md border border-border bg-background focus-within:border-accent/60"
          >
            <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
              <span className="text-xs font-medium text-muted-foreground">Game {i + 1}</span>
              {pgns.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeSlot(i)}
                  disabled={loading}
                  className="text-xs text-muted-foreground transition hover:text-rose-500 disabled:opacity-50"
                >
                  Remove
                </button>
              )}
            </div>
            <textarea
              ref={i === pgns.length - 1 ? lastRef : undefined}
              value={pgn}
              onChange={(e) => updateSlot(i, e.target.value)}
              disabled={loading}
              rows={6}
              spellCheck={false}
              className="block w-full resize-y bg-transparent p-3 font-mono text-xs leading-snug outline-none"
              placeholder={
                i === 0
                  ? `[Event "..."]\n[White "..."]\n[Black "..."]\n[Result "1-0"]\n\n1. e4 c5 2. Nf3 ...  1-0`
                  : 'Paste another PGN game…'
              }
            />
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={addSlot}
        disabled={loading}
        className="rounded-md border border-dashed border-border px-3 py-2 text-xs font-medium text-muted-foreground transition hover:border-foreground/40 hover:text-foreground disabled:opacity-50"
      >
        + Add another game
      </button>

      <div className="flex items-center gap-3 pt-1">
        <button
          type="submit"
          disabled={loading || nonEmptyCount === 0}
          className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {loading
            ? 'AI matching…'
            : nonEmptyCount > 0
              ? `Find their accounts (${nonEmptyCount} game${nonEmptyCount === 1 ? '' : 's'})`
              : 'Find their accounts'}
        </button>
        <p className="text-xs text-muted-foreground">
          {loading ? 'Computing fingerprint and cosine-ranking the corpus…' : '~1–3 seconds'}
        </p>
      </div>
      {error && <p className="text-xs text-rose-500">{error}</p>}
    </form>
  );
}
