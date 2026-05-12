'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Paste-a-PGN form. POSTs sample_pgn to /api/identify, redirects to
 * /scout/match/[query_id]. AI stylometric matching runs in ~1s server-
 * side; we show an inline loading state rather than a polling page since
 * Stage 3 V0 fits comfortably inside a normal HTTP response.
 *
 * Usage:
 *   <SampleGameForm />                                  # standalone (deferred — see plan)
 *   <SampleGameForm federationPlayerId={id} subjectLabel="Gelfand, Boris" />
 *     # anchored to a FIDE player; the match page shows their name as
 *     # the subject and the candidates are persisted with that anchor.
 */
export interface SampleGameFormProps {
  federationPlayerId?: string;
  subjectLabel?: string;
}

export function SampleGameForm({ federationPlayerId, subjectLabel }: SampleGameFormProps = {}) {
  const router = useRouter();
  const [pgn, setPgn] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!pgn.trim()) {
      setError('Paste at least one PGN.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { sample_pgn: pgn };
      if (federationPlayerId) body.federation_player_id = federationPlayerId;
      const res = await fetch('/api/identify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
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
        <label htmlFor="pgn" className="text-sm font-medium">
          Paste 10+ PGN games of{' '}
          {subjectLabel ? <strong>{subjectLabel}</strong> : 'the target player'}
        </label>
        <p className="mt-1 text-xs text-muted-foreground">
          AI matches play patterns against ~1,400 indexed Lichess handles. The target&apos;s real
          handle doesn&apos;t need to resemble their name — works on opening repertoire, time class,
          and opponent-rating signal.
        </p>
        <textarea
          id="pgn"
          value={pgn}
          onChange={(e) => setPgn(e.target.value)}
          disabled={loading}
          rows={14}
          spellCheck={false}
          className="mt-2 w-full rounded-md border border-border bg-background p-3 font-mono text-xs leading-snug"
          placeholder={`[Event "..."]\n[White "..."]\n[Black "..."]\n[Result "1-0"]\n\n1. e4 c5 2. Nf3 ...  1-0`}
        />
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={loading || pgn.trim().length === 0}
          className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {loading ? 'AI matching…' : 'Find their accounts'}
        </button>
        <p className="text-xs text-muted-foreground">
          {loading ? 'Computing fingerprint and cosine-ranking the corpus…' : '~1–3 seconds'}
        </p>
      </div>
      {error && <p className="text-xs text-rose-500">{error}</p>}
    </form>
  );
}
