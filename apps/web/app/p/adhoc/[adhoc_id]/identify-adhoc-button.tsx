'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Trigger Stage 2 name-based identification for an ad-hoc player.
 * Mirrors /p/[player_id]/identify-button.tsx but sends ad_hoc_player_id.
 */
export function IdentifyAdHocButton({ adHocPlayerId }: { adHocPlayerId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/identify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ad_hoc_player_id: adHocPlayerId }),
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
    <div>
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition hover:opacity-90 disabled:opacity-50"
      >
        {loading ? 'Searching…' : 'Find their online accounts'}
      </button>
      {error && <p className="mt-2 text-xs text-rose-500">{error}</p>}
    </div>
  );
}
