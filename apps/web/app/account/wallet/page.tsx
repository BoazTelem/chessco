/**
 * /account/wallet: balance + history shell.
 *
 * Spec §13 provider-agnostic surface. Deposit/withdraw CTAs are intentionally
 * stubbed pending the Stripe-vs-Paddle decision (see the approved plan's
 * §13 PARKED block); the page renders a banner explaining the gating so
 * users aren't confused by inactive buttons.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getUser } from '@/lib/auth';
import { getPracticeDb } from '@/lib/practice/db';
import { walletHoldPeriodDays, type TrustTier } from '@/lib/ledger';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Wallet · Chessco',
  robots: { index: false, follow: false },
};

interface WalletRow {
  available_cents: number;
  pending_cents: number;
  credit_available: number;
  credit_pending: number;
  currency: string;
}

interface LedgerRow {
  id: string;
  transaction_id: string;
  account_type: string;
  direction: string;
  amount_cents: number;
  currency: string;
  category: string;
  reference_type: string | null;
  reference_id: string | null;
  created_at: string;
}

async function loadWallet(profileId: string): Promise<WalletRow | null> {
  const sql = getPracticeDb();
  const rows = await sql<WalletRow[]>`
    SELECT available_cents, pending_cents, credit_available, credit_pending, currency
    FROM wallets
    WHERE profile_id = ${profileId}::uuid
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function loadHistory(profileId: string): Promise<LedgerRow[]> {
  const sql = getPracticeDb();
  return sql<LedgerRow[]>`
    SELECT id::text, transaction_id::text, account_type, direction,
           amount_cents, currency, category, reference_type, reference_id,
           created_at::text
    FROM ledger_entries
    WHERE account_type = 'user_wallet' AND account_id = ${profileId}::uuid
    ORDER BY created_at DESC
    LIMIT 25
  `;
}

function formatCents(amount: number, currency: string): string {
  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : `${currency} `;
  return `${symbol}${(amount / 100).toFixed(2)}`;
}

export default async function WalletPage() {
  const user = await getUser();
  if (!user) redirect('/login?next=/account/wallet');

  // Trust tier column doesn't exist yet (lands in WS-9). Default to 'new'
  // so the hold-period UI surfaces the conservative number; once WS-9
  // ships the tier read, swap this.
  const trustTier: TrustTier = 'new';

  const [wallet, history] = await Promise.all([loadWallet(user.id), loadHistory(user.id)]);
  const holdDays = walletHoldPeriodDays(trustTier);

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 md:py-12">
      <header>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Account</p>
        <h1 className="mt-1 font-display text-2xl font-semibold md:text-3xl">Wallet</h1>
      </header>

      <section className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
        Real-money deposits and withdrawals are paused while we finalize the payment provider
        (Stripe Connect vs. Paddle). Credit-funded practice still works on{' '}
        <Link href="/practice" className="underline">
          /practice
        </Link>
        . You can review history below.
      </section>

      <section className="mt-6 grid gap-3 md:grid-cols-4">
        <BalanceTile
          label="Cash available"
          value={
            wallet ? formatCents(wallet.available_cents, wallet.currency) : formatCents(0, 'USD')
          }
        />
        <BalanceTile
          label="Cash pending"
          value={
            wallet ? formatCents(wallet.pending_cents, wallet.currency) : formatCents(0, 'USD')
          }
          detail="Reserved against open challenges + matches"
        />
        <BalanceTile label="Credits available" value={`${wallet?.credit_available ?? 0} cr`} />
        <BalanceTile
          label="Credits pending"
          value={`${wallet?.credit_pending ?? 0} cr`}
          detail="Reserved against active practice games"
        />
      </section>

      <section className="mt-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled
          title="Deposit will open once the billing provider is selected"
          className="cursor-not-allowed rounded-md border border-border bg-card px-4 py-2 text-sm opacity-50"
        >
          Deposit (paused)
        </button>
        <button
          type="button"
          disabled
          title="Withdraw will open once the billing provider is selected"
          className="cursor-not-allowed rounded-md border border-border bg-card px-4 py-2 text-sm opacity-50"
        >
          Withdraw (paused)
        </button>
        <p className="text-xs text-muted-foreground">
          When live, withdrawals on the <strong>{trustTier}</strong> trust tier clear at T+
          {holdDays} days.
        </p>
      </section>

      <section className="mt-10">
        <h2 className="font-display text-lg font-semibold">Recent activity</h2>
        {history.length === 0 ? (
          <p className="mt-3 rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground">
            No cash ledger activity yet. Once you accept a paid match the escrow flow will record
            entries here.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-md border border-border">
            <table className="min-w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">Category</th>
                  <th className="px-3 py-2 font-medium">Direction</th>
                  <th className="px-3 py-2 font-medium text-right">Amount</th>
                  <th className="px-3 py-2 font-medium">Ref</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {history.map((row) => (
                  <tr key={row.id} className="bg-background">
                    <td className="px-3 py-2 text-muted-foreground">
                      {row.created_at.slice(0, 16).replace('T', ' ')}
                    </td>
                    <td className="px-3 py-2">{row.category}</td>
                    <td className="px-3 py-2">{row.direction === 'D' ? '−' : '+'}</td>
                    <td className="px-3 py-2 text-right">
                      {formatCents(row.amount_cents, row.currency)}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {row.reference_type ?? '-'}
                      {row.reference_id ? ` ${row.reference_id.slice(0, 8)}…` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function BalanceTile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
      {detail ? <p className="mt-1 text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}
