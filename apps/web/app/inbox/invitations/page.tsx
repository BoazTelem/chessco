/**
 * /inbox/invitations — pending challenge invitations addressed to the
 * logged-in user.
 *
 * Spec §8. Renders pending + recently-resolved (so the user has context
 * on "wait, did I accept that?"). Accept/decline are client-side fetch
 * calls to /api/sparring/invitations/[id] (write path lands when the UX
 * is wired through; this page is the read surface).
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getUser } from '@/lib/auth';
import { getPracticeDb } from '@/lib/practice/db';
import { InvitationActions } from './InvitationActions';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Invitations · Chessco',
  robots: { index: false, follow: false },
};

interface Row {
  id: string;
  status: string;
  message: string | null;
  expires_at: string | null;
  created_at: string;
  challenge_id: string;
  challenge_status: string;
  time_class: string;
  time_control: string;
  fee_cents: number;
  currency: string;
  funding_type: string;
  inviter_id: string;
  inviter_name: string | null;
}

async function loadInvitations(userId: string): Promise<Row[]> {
  const sql = getPracticeDb();
  return sql<Row[]>`
    SELECT ci.id::text,
           ci.status,
           ci.message,
           ci.expires_at::text,
           ci.created_at::text,
           c.id::text AS challenge_id,
           c.status AS challenge_status,
           c.time_class,
           c.time_control,
           c.fee_cents,
           c.currency,
           c.funding_type,
           ci.inviter_id::text,
           p.display_name AS inviter_name
    FROM challenge_invitations ci
    JOIN challenges c ON c.id = ci.challenge_id
    JOIN profiles p ON p.id = ci.inviter_id
    WHERE ci.invitee_id = ${userId}::uuid
    ORDER BY
      CASE ci.status WHEN 'pending' THEN 0 ELSE 1 END,
      ci.created_at DESC
    LIMIT 100
  `;
}

function formatFee(cents: number, currency: string, fundingType: string): string {
  if (fundingType === 'credits') return `${cents.toLocaleString()} cr`;
  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : `${currency} `;
  return `${symbol}${(cents / 100).toFixed(2)}`;
}

export default async function InboxInvitationsPage() {
  const user = await getUser();
  if (!user) redirect('/login?next=/inbox/invitations');

  const invitations = await loadInvitations(user.id);
  const pending = invitations.filter((i) => i.status === 'pending');
  const resolved = invitations.filter((i) => i.status !== 'pending');

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 md:py-12">
      <header>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Inbox</p>
        <h1 className="mt-1 font-display text-2xl font-semibold md:text-3xl">Invitations</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Private challenges sent to you. Accept to open the live game room.
        </p>
      </header>

      <section className="mt-8">
        <h2 className="font-display text-lg font-semibold">Pending</h2>
        {pending.length === 0 ? (
          <p className="mt-3 rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground">
            No pending invitations.
          </p>
        ) : (
          <ul className="mt-3 grid gap-3">
            {pending.map((i) => (
              <li key={i.id} className="rounded-lg border border-border bg-card p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <p className="font-semibold">
                      {i.inviter_name ?? 'Someone'}{' '}
                      <span className="font-normal text-muted-foreground">invited you</span>
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {i.time_class} · {i.time_control} ·{' '}
                      {formatFee(i.fee_cents, i.currency, i.funding_type)}
                    </p>
                  </div>
                  <InvitationActions challengeId={i.challenge_id} invitationId={i.id} />
                </div>
                {i.message ? <p className="mt-3 text-sm">{i.message}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {resolved.length > 0 ? (
        <section className="mt-10">
          <h2 className="font-display text-lg font-semibold text-muted-foreground">
            Recently resolved
          </h2>
          <ul className="mt-3 grid gap-2 text-sm">
            {resolved.slice(0, 20).map((i) => (
              <li
                key={i.id}
                className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2"
              >
                <span>
                  {i.inviter_name ?? 'Someone'} · {i.time_class} ·{' '}
                  <span className="text-muted-foreground">{i.status}</span>
                </span>
                <span className="text-xs text-muted-foreground">{i.challenge_status}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
