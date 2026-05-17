/**
 * /practice/sandbox — play a full game vs. a Maia bot. Phase 6A entry point.
 *
 * Server component does auth + env preflight. The actual game state machine
 * lives in SandboxClient (client component) so the chessboard + chess.js
 * runtime + per-move fetches all happen in the browser.
 *
 * Two modes per docs/PRACTICE-CREDIT-MODE.md:
 *   - Casual: no stakes, no credits at risk.
 *   - Credit: bot rating ≥ user's verified rating; +1/-1 credit on win/loss.
 *
 * Both modes share the same UI; the credit toggle is gated server-side
 * inside /api/practice/sandbox/start.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getUser } from '@/lib/auth';
import SandboxClient from './SandboxClient';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Sandbox vs. bot · Chessco',
  description: 'Play a full game against a Maia-style human-skill bot.',
  robots: { index: false, follow: false },
};

export default async function SandboxPage() {
  const user = await getUser();
  if (!user) redirect('/login?next=/practice/sandbox');

  const inferenceConfigured = Boolean(process.env.MAIA_INFERENCE_URL);

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 md:py-12">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Practice</p>
        <h1 className="mt-1 font-display text-2xl font-semibold md:text-3xl">Sandbox vs. bot</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Play a full game against a human-skill bot. Pick a rating bucket and a mode — casual plays
          for fun, credit stakes one credit per game.
        </p>
      </header>

      {!inferenceConfigured ? (
        <section className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
          The Maia inference service is not deployed yet. The bot moves will fail with a 503 until{' '}
          <code className="rounded bg-muted px-1 py-0.5">MAIA_INFERENCE_URL</code> is set. See{' '}
          <code className="rounded bg-muted px-1 py-0.5">docs/MAIA-DEPLOYMENT.md</code>.
        </section>
      ) : null}

      <SandboxClient />
    </main>
  );
}
