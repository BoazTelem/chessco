/**
 * /practice/drill — drill recommended lines vs. an opponent-style Maia bot.
 * Spec §6 Phase 6.
 *
 * Subscription-gated: free tier sees the upsell; paid tiers see the drill
 * UI. The drill itself takes 5–10 positions from a prep report and asks
 * the bot to play the opponent's role; the user practices their planned
 * response. This shell renders the empty-state until the Maia inference
 * worker is configured (MAIA_INFERENCE_URL).
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Drill mode · Chessco',
  description: 'Drill your prep against an opponent-style bot.',
  robots: { index: false, follow: false },
};

export default async function DrillPage({
  searchParams,
}: {
  searchParams: Promise<{ reportId?: string }>;
}) {
  const user = await getUser();
  if (!user) redirect('/login?next=/practice/drill');
  const { reportId } = await searchParams;

  const inferenceConfigured = Boolean(process.env.MAIA_INFERENCE_URL);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 md:py-12">
      <header>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Practice</p>
        <h1 className="mt-1 font-display text-2xl font-semibold md:text-3xl">Drill mode</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Drill the recommended lines from a prep report against a bot that mimics your
          opponent&apos;s style. Each drill position is one of the leaks the matcher surfaced.
        </p>
      </header>

      {!inferenceConfigured ? (
        <section className="mt-8 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
          The Maia inference service is not yet deployed. Drill mode requires a running Cloud Run
          worker; set <code>MAIA_INFERENCE_URL</code> in the web env once it lands. The contract
          lives in{' '}
          <code className="rounded bg-muted px-1 py-0.5">apps/web/lib/maia/inference.ts</code>.
        </section>
      ) : reportId ? (
        <section className="mt-8 rounded-md border border-dashed border-border bg-card p-6 text-sm text-muted-foreground">
          Drill UI for report {reportId.slice(0, 8)}… will render here once the React drill
          component lands. The server-side flow is already wired:{' '}
          <code className="rounded bg-muted px-1 py-0.5">getBotMove()</code> →{' '}
          <code className="rounded bg-muted px-1 py-0.5">MAIA_INFERENCE_URL/move</code>.
        </section>
      ) : (
        <section className="mt-8 rounded-md border border-dashed border-border bg-card p-6">
          <h2 className="font-display text-lg font-semibold">Start a drill</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Open a prep report and click &quot;Drill these positions&quot; to launch the drill UI
            here.
          </p>
          <Link
            href="/prepare"
            className="mt-4 inline-block rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-muted"
          >
            Build a prep report
          </Link>
        </section>
      )}

      <section className="mt-10 rounded-md border border-border bg-card p-4 text-xs text-muted-foreground">
        Subscription required for paid Maia bots. The free tier can drill against the generic Maia
        ladder (maia-1500, maia-1900) without per-player fine-tuning.
      </section>
    </main>
  );
}
