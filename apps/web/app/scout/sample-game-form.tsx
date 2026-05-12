'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type SlotIssue = { kind: 'empty' } | { kind: 'ok' } | { kind: 'invalid'; missing: string[] };

const TAG_RE = /\[([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\]/g;

/**
 * Split a multi-game PGN file into individual game blocks. Boundary
 * = first header line after a moves line. Robust to Lichess
 * (`\n\n` between games) and chess.com (`\n\n\n`) export shapes.
 */
function splitPgnFile(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const games: string[] = [];
  let cur: string[] = [];
  let sawMoves = false;
  for (const raw of lines) {
    const line = raw;
    if (line.startsWith('[') && sawMoves) {
      games.push(cur.join('\n').trim());
      cur = [line];
      sawMoves = false;
      continue;
    }
    cur.push(line);
    if (!line.startsWith('[') && line.trim() !== '') sawMoves = true;
  }
  if (cur.length > 0) {
    const last = cur.join('\n').trim();
    if (last) games.push(last);
  }
  return games.filter((g) => g.length > 0);
}

/** Required PGN tags for the Stage 3 matcher. Anything else parses but
 *  is dropped server-side, so we surface that to the user before submit. */
function validateSlot(raw: string): SlotIssue {
  const text = raw.trim();
  if (text.length === 0) return { kind: 'empty' };

  const tags = new Set<string>();
  for (const m of text.matchAll(TAG_RE)) tags.add(m[1]!);

  const missing: string[] = [];
  if (!tags.has('White')) missing.push('[White]');
  if (!tags.has('Black')) missing.push('[Black]');
  if (!tags.has('Result')) missing.push('[Result]');

  // ECO isn't required for parsing to succeed, but the matcher leans on
  // it heavily — warn so the user knows to grab a full export.
  if (!tags.has('ECO')) missing.push('[ECO] (recommended)');

  // Move text is the cheapest sanity check — at least one "N." move number.
  if (!/\b\d+\.\s*[A-Za-z]/.test(text)) missing.push('move text');

  return missing.length === 0 ? { kind: 'ok' } : { kind: 'invalid', missing };
}

/**
 * Identity fingerprint for dedupe across slots. Same game pasted twice
 * skews the Stage 3 fingerprint (every GameRow contributes equally), so
 * we block submit on dups.
 *
 * Strategy: extract a stable subset of headers (players, date, result,
 * round, site URL) — handles same-export-twice and same-game-from-
 * different-formats. Falls back to a moves-text hash so games without a
 * Site/Link tag still get caught.
 */
function fingerprintSlot(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  const tags: Record<string, string> = {};
  for (const m of text.matchAll(TAG_RE)) tags[m[1]!] = m[2]!;

  const headerKey = [
    (tags.White ?? '').toLowerCase().trim(),
    (tags.Black ?? '').toLowerCase().trim(),
    tags.UTCDate ?? tags.Date ?? '',
    tags.UTCTime ?? '',
    tags.Result ?? '',
    tags.Round ?? '',
    tags.Site ?? tags.Link ?? '',
  ].join('|');

  // If header key has no players AND no site, fall back to moves hash so
  // a header-stripped paste still dedupes.
  const hasHeaderIdentity =
    (tags.White || tags.Black) && (tags.UTCDate || tags.Date || tags.Site || tags.Link);
  if (hasHeaderIdentity) return `h:${headerKey}`;

  // Moves fallback: strip tag lines, collapse whitespace, lowercase.
  const moves = text
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return moves.length > 0 ? `m:${moves}` : null;
}

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
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function onLoadFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input so re-picking the same file still triggers change.
    e.target.value = '';
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      setError('Could not read file.');
      return;
    }
    const games = splitPgnFile(text);
    if (games.length === 0) {
      setError(`No games found in ${file.name}. Expected a .pgn file with [Event ...] headers.`);
      return;
    }
    setError(null);
    // Replace any empty slots first; append the rest.
    setPgns((cur) => {
      const out = [...cur];
      let gi = 0;
      for (let i = 0; i < out.length && gi < games.length; i++) {
        if (out[i]!.trim() === '') {
          out[i] = games[gi]!;
          gi++;
        }
      }
      while (gi < games.length) {
        out.push(games[gi]!);
        gi++;
      }
      return out;
    });
  }

  const slotIssues = useMemo(() => pgns.map(validateSlot), [pgns]);
  const nonEmptyCount = slotIssues.filter((s) => s.kind !== 'empty').length;
  const invalidCount = slotIssues.filter(
    (s) =>
      s.kind === 'invalid' &&
      // Treat ECO-only as a soft warning; block submit only on hard misses.
      s.missing.some((m) => !m.includes('recommended')),
  ).length;

  /** Map slot index → 1-based group number when its PGN matches another slot. */
  const dupGroups = useMemo(() => {
    const byFp = new Map<string, number[]>();
    pgns.forEach((p, i) => {
      const fp = fingerprintSlot(p);
      if (!fp) return;
      const arr = byFp.get(fp);
      if (arr) arr.push(i);
      else byFp.set(fp, [i]);
    });
    const groups = new Map<number, number>();
    let g = 0;
    for (const indices of byFp.values()) {
      if (indices.length < 2) continue;
      g++;
      for (const idx of indices) groups.set(idx, g);
    }
    return groups;
  }, [pgns]);
  const dupCount = dupGroups.size;

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
        {pgns.map((pgn, i) => {
          const issue = slotIssues[i]!;
          const hardMissing =
            issue.kind === 'invalid' ? issue.missing.filter((m) => !m.includes('recommended')) : [];
          const softMissing =
            issue.kind === 'invalid' ? issue.missing.filter((m) => m.includes('recommended')) : [];
          const dupGroup = dupGroups.get(i);
          const borderClass =
            issue.kind === 'empty'
              ? 'border-border'
              : dupGroup !== undefined
                ? 'border-rose-500/60'
                : hardMissing.length > 0
                  ? 'border-rose-500/60'
                  : softMissing.length > 0
                    ? 'border-amber-500/60'
                    : 'border-emerald-500/40';
          return (
            <div
              key={i}
              className={`overflow-hidden rounded-md border ${borderClass} bg-background transition-colors focus-within:border-accent/60`}
            >
              <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Game {i + 1}
                  {dupGroup !== undefined && (
                    <span className="ml-2 text-rose-500">
                      duplicate of another slot{dupCount > 2 ? ` (group ${dupGroup})` : ''}
                    </span>
                  )}
                  {dupGroup === undefined && issue.kind === 'ok' && (
                    <span className="ml-2 text-emerald-500">✓ valid PGN</span>
                  )}
                  {dupGroup === undefined && hardMissing.length > 0 && (
                    <span className="ml-2 text-rose-500">missing {hardMissing.join(', ')}</span>
                  )}
                  {dupGroup === undefined && hardMissing.length === 0 && softMissing.length > 0 && (
                    <span className="ml-2 text-amber-500">missing {softMissing.join(', ')}</span>
                  )}
                </span>
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
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={addSlot}
          disabled={loading}
          className="rounded-md border border-dashed border-border px-3 py-2 text-xs font-medium text-muted-foreground transition hover:border-foreground/40 hover:text-foreground disabled:opacity-50"
        >
          + Add another game
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={loading}
          className="rounded-md border border-dashed border-border px-3 py-2 text-xs font-medium text-muted-foreground transition hover:border-foreground/40 hover:text-foreground disabled:opacity-50"
        >
          ↑ Load PGN file
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".pgn,.txt,application/x-chess-pgn,text/plain"
          onChange={onLoadFile}
          className="hidden"
        />
        <span className="text-xs text-muted-foreground">
          Multi-game PGN files are split automatically.
        </span>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <button
          type="submit"
          disabled={loading || nonEmptyCount === 0 || invalidCount > 0 || dupCount > 0}
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
      {invalidCount > 0 && (
        <p className="text-xs text-rose-500">
          {invalidCount} game{invalidCount === 1 ? '' : 's'} missing required PGN tags — paste the
          full PGN export (with the bracketed headers on top), not just the moves.
        </p>
      )}
      {dupCount > 0 && (
        <p className="text-xs text-rose-500">
          {dupCount} slot{dupCount === 1 ? '' : 's'} contain the same game — remove the duplicates
          so each PGN is counted once in the fingerprint.
        </p>
      )}
      {error && <p className="text-xs text-rose-500">{error}</p>}
    </form>
  );
}
