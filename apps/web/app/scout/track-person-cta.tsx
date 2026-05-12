'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { countryFlag, countryName } from '@/lib/scout/countries';

/**
 * "No match? Track this person anyway →" CTA on /scout empty-state.
 * Auth-gated: signed-out users see a sign-in prompt instead of the button.
 * Auth signal comes from the parent (server component reads getUser()).
 */
export function TrackPersonCTA({
  name,
  country,
  signedIn,
}: {
  name: string;
  country: string | null;
  signedIn: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const flag = countryFlag(country);
  const where = country ? `${flag} ${countryName(country)}` : 'any country';

  async function onClick() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/ad-hoc-player', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, country }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const { id } = (await res.json()) as { id: string };
      router.push(`/p/adhoc/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'request failed');
      setLoading(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-6 text-center">
      <p className="text-sm">
        No exact match for <span className="font-medium">&ldquo;{name}&rdquo;</span> in {where}.
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        Track this person anyway — you&apos;ll get a profile page where AI can find their online
        accounts from their games. Identified handles persist for future searches.
      </p>
      <div className="mt-4">
        {signedIn ? (
          <button
            type="button"
            onClick={onClick}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground hover:opacity-90 disabled:opacity-50"
          >
            {loading ? 'Creating…' : `Track ${name} →`}
          </button>
        ) : (
          <Link
            href={`/login?next=${encodeURIComponent(typeof window === 'undefined' ? '/scout' : window.location.pathname + window.location.search)}`}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground hover:opacity-90"
          >
            Sign in to track this person →
          </Link>
        )}
        {error && <p className="mt-2 text-xs text-rose-500">{error}</p>}
      </div>
    </div>
  );
}
