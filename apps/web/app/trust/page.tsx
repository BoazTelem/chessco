import Link from 'next/link';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { brand } from '@chessco/ui';
import { ChesscoMark } from '@/lib/logo';

export const metadata = {
  title: 'Trust — identification accuracy',
  description:
    'Public leave-K-out evaluation of Chessco Scout identification accuracy across the indexed corpus. Methodology is open.',
};

interface BandStats {
  band: string;
  n: number;
  top1: number;
  top5: number;
  top10: number;
  mrr: number;
}

interface EvalSummary {
  run_at: string;
  methodology: string;
  features_version: string;
  features_used: string[];
  k_test_games: number;
  min_handle_games: number;
  total_handles_qualified: number;
  /** Fraction of handles whose train + test slices both had cp-loss signal. */
  cp_loss_coverage?: number;
  cp_loss_handles_with_signal?: number;
  overall: { top1: number; top5: number; top10: number; mrr: number };
  by_band: BandStats[];
}

async function loadSummary(): Promise<EvalSummary | null> {
  try {
    // The eval JSON is committed under apps/web/public so it ships with the
    // deployment. We read from the filesystem rather than fetch — server
    // components can do that and it avoids a self-call at build time.
    const path = join(process.cwd(), 'public', 'trust-eval.json');
    const text = await readFile(path, 'utf8');
    return JSON.parse(text) as EvalSummary;
  } catch {
    return null;
  }
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

const BAND_LABELS: Record<string, string> = {
  '<1500': 'Under 1500',
  '1500-1799': '1500–1799',
  '1800-2099': '1800–2099',
  '2100+': '2100 and up',
  unknown: 'No rating data',
};

export default async function TrustPage() {
  const summary = await loadSummary();

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-card/50">
        <div className="container mx-auto flex items-center justify-between px-4 py-4">
          <div className="flex items-center gap-2 text-sm">
            <Link
              href="/"
              aria-label={brand.name}
              className="inline-flex items-center gap-2 hover:opacity-80"
            >
              <ChesscoMark className="h-4 w-4 shrink-0" />
              <span className="font-display font-semibold uppercase tracking-[0.3em] text-accent">
                {brand.name}
              </span>
            </Link>
            <span className="text-muted-foreground">/</span>
            <span className="text-foreground">Trust</span>
          </div>
        </div>
      </header>

      <main className="container mx-auto max-w-3xl px-4 py-10">
        <section>
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">Trust</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight md:text-4xl">
            How accurate is Scout?
          </h1>
          <p className="mt-3 text-sm text-muted-foreground md:text-base">
            We publish identification accuracy so you can judge whether to trust our match
            confidence. Numbers below come from a held-out evaluation across every handle we&apos;ve
            indexed — not a curated demo set.
          </p>
        </section>

        {summary === null ? (
          <section className="mt-10 rounded-lg border border-amber-500/30 bg-amber-500/5 p-5">
            <p className="text-sm">No evaluation results have been published yet.</p>
          </section>
        ) : (
          <>
            <section className="mt-10">
              <h2 className="font-display text-lg font-semibold">Overall</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Across {summary.total_handles_qualified.toLocaleString()} indexed handles, each with
                ≥ {summary.min_handle_games} games, holding out {summary.k_test_games} games per
                handle as the sample query.
              </p>
              <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                <Metric label="Top-1" value={pct(summary.overall.top1)} />
                <Metric label="Top-5" value={pct(summary.overall.top5)} />
                <Metric label="Top-10" value={pct(summary.overall.top10)} />
                <Metric label="MRR" value={summary.overall.mrr.toFixed(3)} />
              </div>
            </section>

            <section className="mt-10">
              <h2 className="font-display text-lg font-semibold">By rating band</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Bucketed by each handle&apos;s average opponent rating — a proxy for their own
                strength.
              </p>
              <div className="mt-4 overflow-hidden rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/30 text-xs uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left">Band</th>
                      <th className="px-3 py-2 text-right">n</th>
                      <th className="px-3 py-2 text-right">Top-1</th>
                      <th className="px-3 py-2 text-right">Top-5</th>
                      <th className="px-3 py-2 text-right">Top-10</th>
                      <th className="px-3 py-2 text-right">MRR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.by_band.map((b) => (
                      <tr key={b.band} className="border-t border-border">
                        <td className="px-3 py-2">{BAND_LABELS[b.band] ?? b.band}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {b.n.toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-right font-semibold tabular-nums">
                          {pct(b.top1)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{pct(b.top5)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{pct(b.top10)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{b.mrr.toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Per-band accuracy depends on candidate density much more than on signal quality. The
                2100+ band now contains ~2,200 indexed strong-player handles whose opening
                repertoires overlap heavily (everyone plays mainlines), so the matcher faces a
                harder discrimination problem there than in the sparser 1800-2099 band. We publish
                raw numbers, not curated ones.
              </p>
            </section>

            <section className="mt-10">
              <h2 className="font-display text-lg font-semibold">Methodology</h2>
              <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
                <li>
                  <strong className="text-foreground">Test set:</strong> for every indexed handle
                  with ≥ {summary.min_handle_games} games, we hold out {summary.k_test_games} games
                  at random as the &ldquo;sample paste.&rdquo;
                </li>
                <li>
                  <strong className="text-foreground">Corpus:</strong> every handle&apos;s remaining
                  games are aggregated into a feature vector. There is no test leakage for the
                  handle being evaluated.
                </li>
                <li>
                  <strong className="text-foreground">Query:</strong> the held-out games become a
                  fingerprint that is ranked against every handle in the corpus. We record the rank
                  at which the correct handle appears.
                </li>
                <li>
                  <strong className="text-foreground">Score:</strong> Top-N counts the share of
                  queries where the right handle landed in the top N candidates. MRR (mean
                  reciprocal rank) penalizes deep ranks more than a raw top-N percentage.
                </li>
                <li>
                  <strong className="text-foreground">
                    Features ({summary.features_version}
                    ):
                  </strong>{' '}
                  {summary.features_used.join(', ')}.
                  {summary.cp_loss_coverage !== undefined && summary.cp_loss_coverage > 0 ? (
                    <>
                      {' '}
                      Stockfish cp-loss signal was active for{' '}
                      <strong className="text-foreground">
                        {pct(summary.cp_loss_coverage)}
                      </strong>{' '}
                      of the handles in this run (
                      {summary.cp_loss_handles_with_signal?.toLocaleString()} of{' '}
                      {summary.total_handles_qualified.toLocaleString()}). Handles without analyzed
                      games yet contribute 0 on the cp-loss component so the matcher degrades
                      gracefully during the rolling backfill.
                    </>
                  ) : (
                    <>
                      {' '}
                      Stockfish-derived signals (per-ply cp-loss, blunder rate) are NOT yet active
                      in this run — they&apos;re scheduled for the next upgrade and should lift the
                      lower bands significantly.
                    </>
                  )}
                </li>
              </ul>
            </section>

            <section className="mt-10">
              <h2 className="font-display text-lg font-semibold">
                What this doesn&apos;t tell you
              </h2>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                <li>
                  This measures self-match: given games we&apos;ve indexed, can we find the handle
                  back? In production, the user&apos;s pasted games may be from a fresher time
                  period than our last ingest — accuracy on truly unseen games will be lower.
                </li>
                <li>
                  We don&apos;t yet evaluate cross-platform matching (a Lichess paste finding a
                  chess.com handle by play style). That&apos;s a planned eval after Stockfish
                  features ship.
                </li>
                <li>
                  Most of the corpus today is Lichess. chess.com depth is shallow and will grow as
                  the per-handle crawler runs.
                </li>
              </ul>
            </section>

            <section className="mt-10 border-t border-border pt-6 text-xs text-muted-foreground">
              <p>
                Last evaluated:{' '}
                <time dateTime={summary.run_at}>{new Date(summary.run_at).toUTCString()}</time>.
                Eval script:{' '}
                <code className="rounded bg-muted/40 px-1.5 py-0.5 text-foreground">
                  apps/workers/src/eval/run.ts
                </code>{' '}
                — re-run with{' '}
                <code className="rounded bg-muted/40 px-1.5 py-0.5 text-foreground">
                  pnpm --filter @chessco/workers exec tsx src/eval/run.ts
                </code>
                .
              </p>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 text-center">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 font-display text-2xl font-bold tabular-nums text-foreground">{value}</p>
    </div>
  );
}
