'use client';

import { useState } from 'react';

type BoardTheme = 'classic' | 'wood' | 'green' | 'blue' | 'gray';
type PieceSet = 'cburnett' | 'merida' | 'alpha' | 'staunton';

interface Prefs {
  boardTheme: BoardTheme;
  pieceSet: PieceSet;
  soundEnabled: boolean;
  animationsEnabled: boolean;
  premovesEnabled: boolean;
  autoPromoteQueen: boolean;
  showLegalMoves: boolean;
  showCoordinates: boolean;
}

export function PracticePrefsForm({ initial }: { initial: Prefs }) {
  const [prefs, setPrefs] = useState<Prefs>(initial);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function save(next: Prefs) {
    setStatus('saving');
    setError(null);
    try {
      const res = await fetch('/api/practice/prefs', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? 'Failed to save.');
        setStatus('error');
        return;
      }
      setStatus('saved');
      setTimeout(() => setStatus('idle'), 1500);
    } catch {
      setError('Network error.');
      setStatus('error');
    }
  }

  function update<K extends keyof Prefs>(key: K, value: Prefs[K]) {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    void save(next);
  }

  return (
    <div className="space-y-6">
      <section>
        <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Board theme
        </label>
        <div className="flex flex-wrap gap-2">
          {(['classic', 'wood', 'green', 'blue', 'gray'] as BoardTheme[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => update('boardTheme', t)}
              className={`rounded-md border px-3 py-1.5 text-sm capitalize ${
                prefs.boardTheme === t
                  ? 'border-accent bg-accent text-accent-foreground'
                  : 'border-border bg-background hover:bg-muted'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </section>

      <section>
        <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Piece set
        </label>
        <div className="flex flex-wrap gap-2">
          {(['cburnett', 'merida', 'alpha', 'staunton'] as PieceSet[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => update('pieceSet', p)}
              className={`rounded-md border px-3 py-1.5 text-sm capitalize ${
                prefs.pieceSet === p
                  ? 'border-accent bg-accent text-accent-foreground'
                  : 'border-border bg-background hover:bg-muted'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Behaviour
        </p>
        <Toggle
          label="Sound effects"
          value={prefs.soundEnabled}
          onChange={(v) => update('soundEnabled', v)}
        />
        <Toggle
          label="Piece animations"
          value={prefs.animationsEnabled}
          onChange={(v) => update('animationsEnabled', v)}
        />
        <Toggle
          label="Premoves"
          value={prefs.premovesEnabled}
          onChange={(v) => update('premovesEnabled', v)}
        />
        <Toggle
          label="Auto-promote to Queen"
          value={prefs.autoPromoteQueen}
          onChange={(v) => update('autoPromoteQueen', v)}
        />
        <Toggle
          label="Show legal moves"
          value={prefs.showLegalMoves}
          onChange={(v) => update('showLegalMoves', v)}
        />
        <Toggle
          label="Show coordinates"
          value={prefs.showCoordinates}
          onChange={(v) => update('showCoordinates', v)}
        />
      </section>

      <p className="text-xs text-muted-foreground">
        {status === 'saving' && 'Saving…'}
        {status === 'saved' && 'Saved.'}
        {status === 'error' && (error ?? 'Failed to save.')}
      </p>
    </div>
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-sm">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4"
      />
    </label>
  );
}
