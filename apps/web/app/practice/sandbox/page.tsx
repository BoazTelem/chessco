/**
 * /practice/sandbox — play a full game vs. a Maia bot. Spec §6 Phase 6.
 *
 * Differs from /practice/drill in two ways:
 *   1. Full game from the starting position (no prep-report tie-in).
 *   2. Free for all signed-in users (no subscription gate). Acts as an
 *      always-available practice surface that doesn't burn credits.
 *
 * The game runs entirely on the realtime server with `match.status =
 * sandbox`; settle path bypasses the wallet entirely.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Sandbox vs. bot · Chessco',
  description: 'Play a full game against a chess.com / Lichess-style bot.',
  robots: { index: false, follow: false },
};

export default async function SandboxPage() {
  const user = await getUser();
  if (!user) redirect('/login?next=/practice/sandbox');

  const inferenceConfigured = Boolean(process.env.MAIA_INFERENCE_URL);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 md:py-12">
      <header>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Practice</p>
        <h1 className="mt-1 font-display text-2xl font-semibold md:text-3xl">Sandbox vs. bot</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Play an unrated game against a Maia-style bot. No fee, no credits — just chess.
        </p>
      </header>

      {!inferenceConfigured ? (
        <section className="mt-8 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
          The Maia inference service is not yet deployed. See{' '}
          <code className="rounded bg-muted px-1 py-0.5">docs/MAIA-INFERENCE.md</code> for the
          worker contract.
        </section>
      ) : (
        <section className="mt-8 grid gap-3 md:grid-cols-3">
          {(['maia-1500', 'maia-1700', 'maia-1900'] as const).map((level) => (
            <div key={level} className="rounded-lg border border-border bg-card p-4">
              <p className="font-semibold">{level}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Plays at approximately this rating level. Sample-based; not engine-perfect.
              </p>
              <button
                type="button"
                disabled
                title="Sandbox game launcher lands with the realtime sandbox session work"
                className="mt-3 cursor-not-allowed rounded-md border border-border bg-background px-3 py-1.5 text-xs opacity-50"
              >
                Start (coming)
              </button>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
