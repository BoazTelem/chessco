/**
 * /prepare/otb — over-the-board tournament prep mode. Spec §6 Phase 6.
 *
 * Entry shell: user enters their FIDE ID + the tournament URL (typically
 * chess-results.com). The backend resolves the pairing for the next round
 * and dispatches prep-report builds in parallel against each known
 * opponent's online accounts.
 *
 * The pairing fetch + dispatcher is operator work (requires chess-results
 * scraping permission); this page stubs the entry form so the URL is
 * stable in marketing / blog content.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'OTB tournament prep · Chessco',
  description: 'Bundle prep reports for every pairing in your next round.',
};

export default async function OtbPrepPage() {
  const user = await getUser();
  if (!user) redirect('/login?next=/prepare/otb');

  return (
    <main className="mx-auto max-w-2xl px-4 py-8 md:py-12">
      <header>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Prepare</p>
        <h1 className="mt-1 font-display text-2xl font-semibold md:text-3xl">
          OTB tournament prep
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Paste a tournament URL and your FIDE ID. We resolve your next pairing, find each
          opponent&apos;s online accounts (chess.com / Lichess), and bundle prep reports against
          every known account in one shot.
        </p>
      </header>

      <section className="mt-6 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
        OTB prep is currently in private beta — the pairing-resolution worker is operator-gated and
        requires explicit chess-results permission. Email{' '}
        <a href="mailto:beta@chessco.org" className="underline">
          beta@chessco.org
        </a>{' '}
        to request access.
      </section>

      <form className="mt-8 grid gap-4" action="/api/prepare/otb" method="post" aria-disabled>
        <label className="grid gap-1 text-sm">
          <span className="font-medium">Your FIDE ID</span>
          <input
            name="fide_id"
            type="text"
            placeholder="e.g. 1503014"
            disabled
            className="rounded-md border border-border bg-card px-3 py-2 text-sm disabled:opacity-50"
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-medium">Tournament URL</span>
          <input
            name="tournament_url"
            type="url"
            placeholder="https://chess-results.com/tnr…"
            disabled
            className="rounded-md border border-border bg-card px-3 py-2 text-sm disabled:opacity-50"
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-medium">Round to prepare</span>
          <input
            name="round"
            type="number"
            placeholder="next"
            disabled
            className="rounded-md border border-border bg-card px-3 py-2 text-sm disabled:opacity-50"
          />
        </label>
        <button
          type="submit"
          disabled
          className="cursor-not-allowed rounded-md border border-border bg-card px-4 py-2 text-sm opacity-50"
        >
          Bundle prep (paused — private beta)
        </button>
      </form>
    </main>
  );
}
