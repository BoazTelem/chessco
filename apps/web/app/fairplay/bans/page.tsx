/**
 * /fairplay/bans — public ban list (opt-in transparency). Spec §12.
 *
 * Shows confirmed severity-5 and severity-6 ban_actions for users who
 * opted into public listing. Severity 1-4 stays private (warnings and
 * paid-play-only suspensions don't get a permanent public mark).
 *
 * Opt-in flag lives on profiles (profile_visibility = 'public') — we
 * reuse the existing visibility field rather than adding a new column.
 * Players whose profile is 'private' or 'coach_public_player_private'
 * are NOT shown.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { getPracticeDb } from '@/lib/practice/db';

export const dynamic = 'force-dynamic';
export const revalidate = 3600;

export const metadata: Metadata = {
  title: 'Public ban list · Chessco',
  description:
    'Confirmed permanent fairplay actions on Chessco, for accounts that opted into public listing.',
};

interface BanRow {
  id: string;
  profile_id: string;
  display_name: string | null;
  severity: number;
  reason: string;
  created_at: string;
}

async function loadBans(): Promise<BanRow[]> {
  const sql = getPracticeDb();
  return sql<BanRow[]>`
    SELECT ba.id::text,
           ba.profile_id::text,
           p.display_name,
           ba.severity,
           ba.reason,
           ba.created_at::text
    FROM ban_actions ba
    JOIN profiles p ON p.id = ba.profile_id
    WHERE ba.severity >= 5
      AND ba.reversed_at IS NULL
      AND (ba.expires_at IS NULL OR ba.expires_at > NOW())
      AND p.profile_visibility = 'public'
      AND p.deleted_at IS NULL
    ORDER BY ba.created_at DESC
    LIMIT 200
  `;
}

export default async function PublicBanListPage() {
  const bans = await loadBans();

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 md:py-12">
      <header>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Fairplay</p>
        <h1 className="mt-1 font-display text-2xl font-semibold md:text-3xl">Public ban list</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Confirmed permanent fairplay actions on Chessco for accounts that opted into public
          listing. Severity 1–4 (warnings and paid-play-only suspensions) stay private. See our{' '}
          <Link href="/terms" className="underline">
            Terms
          </Link>{' '}
          for the severity ladder and appeal process.
        </p>
      </header>

      {bans.length === 0 ? (
        <p className="mt-8 rounded-md border border-dashed border-border bg-card p-6 text-sm text-muted-foreground">
          No public bans on record. (This page renders only opted-in entries.)
        </p>
      ) : (
        <ul className="mt-6 grid gap-2 text-sm">
          {bans.map((b) => (
            <li
              key={b.id}
              className="flex items-baseline justify-between rounded-md border border-border bg-card px-4 py-2"
            >
              <span>
                <strong>{b.display_name ?? '(no display name)'}</strong>{' '}
                <span className="text-xs text-muted-foreground">severity {b.severity}</span>
              </span>
              <span className="text-xs text-muted-foreground">{b.created_at.slice(0, 10)}</span>
            </li>
          ))}
        </ul>
      )}

      <section className="mt-12 rounded-md border border-border bg-card p-4 text-xs text-muted-foreground">
        <p>
          We publish an annual <strong>Fairplay Transparency Report</strong> covering false-positive
          rates, action counts by severity, and notable appeal outcomes. Operator export:{' '}
          <code className="rounded bg-muted px-1 py-0.5">
            pnpm --filter @chessco/workers fairplay:transparency
          </code>
          .
        </p>
      </section>
    </main>
  );
}
