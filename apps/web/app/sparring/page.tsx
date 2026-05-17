/**
 * /sparring — public directory of players who opted into being challenged.
 *
 * Spec §8. Reads from player_sparring_profiles + player_sparring_fees;
 * filters out `opted_in = false` and players whose away_until is in the
 * future. Sort order: recently-online first, then most completed matches.
 *
 * No write surface here — opt-in/edits happen at /account/practice (or a
 * sparring profile page lands in a follow-up). Anonymous users can browse
 * but the "invite" CTA is gated on login.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { getPracticeDb } from '@/lib/practice/db';
import { getUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const revalidate = 30;

export const metadata: Metadata = {
  title: 'Sparring directory · Chessco',
  description:
    'Players who have opted into private challenges. Filter by time class and fee, then send an invitation.',
};

interface DirectoryRow {
  profile_id: string;
  display_name: string | null;
  bio: string | null;
  glicko_rating: number | null;
  completed_matches: number;
  last_online_at: string | null;
  away_until: string | null;
  fees: Array<{ time_class: string; fee_cents: number; currency: string; funding_type: string }>;
}

async function loadDirectory(): Promise<DirectoryRow[]> {
  const sql = getPracticeDb();
  type Row = {
    profile_id: string;
    display_name: string | null;
    bio: string | null;
    glicko_rating: number | null;
    completed_matches: number;
    last_online_at: string | null;
    away_until: string | null;
    fees: DirectoryRow['fees'] | string | null;
  };
  const rows = await sql<Row[]>`
    SELECT psp.profile_id::text,
           p.display_name,
           psp.bio,
           psp.glicko_rating,
           psp.completed_matches,
           psp.last_online_at::text,
           psp.away_until::text,
           COALESCE(
             (
               SELECT jsonb_agg(jsonb_build_object(
                 'time_class', psf.time_class,
                 'fee_cents', psf.fee_cents,
                 'currency', psf.currency,
                 'funding_type', psf.funding_type
               ) ORDER BY psf.time_class)
               FROM player_sparring_fees psf
               WHERE psf.profile_id = psp.profile_id AND psf.active = true
             ),
             '[]'::jsonb
           ) AS fees
    FROM player_sparring_profiles psp
    JOIN profiles p ON p.id = psp.profile_id
    WHERE psp.opted_in = true
      AND (psp.away_until IS NULL OR psp.away_until <= NOW())
    ORDER BY psp.last_online_at DESC NULLS LAST, psp.completed_matches DESC
    LIMIT 100
  `;
  return rows.map((r) => ({
    ...r,
    fees: Array.isArray(r.fees)
      ? r.fees
      : typeof r.fees === 'string'
        ? (JSON.parse(r.fees) as DirectoryRow['fees'])
        : [],
  }));
}

function formatFee(cents: number, currency: string): string {
  if (currency === 'CRED') return `${cents.toLocaleString()} cr`;
  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : `${currency} `;
  return `${symbol}${(cents / 100).toFixed(2)}`;
}

function lastSeenLabel(iso: string | null): string {
  if (!iso) return 'never seen';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 5) return 'online now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default async function SparringDirectoryPage() {
  const [user, players] = await Promise.all([getUser(), loadDirectory()]);

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 md:py-12">
      <header>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Sparring</p>
        <h1 className="mt-1 font-display text-2xl font-semibold md:text-3xl">
          Players accepting challenges
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Players who opted into being challenged. Pick someone, then create a position challenge
          targeted at them. They get an invitation in their inbox.
        </p>
      </header>

      {players.length === 0 ? (
        <section className="mt-8 rounded-md border border-dashed border-border bg-card p-6">
          <h2 className="font-display text-lg font-semibold">No players opted in yet</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Be the first — visit your{' '}
            <Link href="/account/practice" className="underline">
              practice preferences
            </Link>{' '}
            to opt in.
          </p>
        </section>
      ) : (
        <ul className="mt-8 grid gap-3">
          {players.map((p) => (
            <li
              key={p.profile_id}
              className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-foreground/30"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <p className="font-semibold">{p.display_name ?? 'Anonymous player'}</p>
                  <p className="text-xs text-muted-foreground">
                    {p.glicko_rating ? `${p.glicko_rating}` : 'unrated'} · {p.completed_matches}{' '}
                    matches · {lastSeenLabel(p.last_online_at)}
                  </p>
                </div>
                {user ? (
                  <Link
                    href={`/practice/create?inviteeId=${p.profile_id}`}
                    className="rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-muted"
                  >
                    Invite to a match
                  </Link>
                ) : (
                  <Link
                    href="/login?next=/sparring"
                    className="rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-muted"
                  >
                    Sign in to invite
                  </Link>
                )}
              </div>
              {p.bio ? <p className="mt-2 text-sm text-muted-foreground">{p.bio}</p> : null}
              {p.fees.length > 0 ? (
                <ul className="mt-3 flex flex-wrap gap-2 text-xs">
                  {p.fees.map((f) => (
                    <li
                      key={f.time_class}
                      className="rounded-full border border-border bg-background px-2 py-0.5"
                    >
                      {f.time_class}: {formatFee(f.fee_cents, f.currency)}
                      {f.funding_type !== 'either' ? ` (${f.funding_type})` : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
