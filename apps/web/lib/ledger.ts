/**
 * Provider-agnostic double-entry ledger helpers.
 *
 * The cash ledger lives in `ledger_entries` (see packages/db/src/schema.ts).
 * Every transaction MUST balance: SUM(debits) == SUM(credits) per
 * (transaction_id, currency). postLedgerTransaction() enforces that
 * invariant at write time so an unbalanced transaction can't slip through
 * a callsite refactor.
 *
 * Spec §13. The provider-specific surface (Stripe Connect / Paddle
 * onboarding, webhooks, deposit/payout HTTP calls) is PARKED — see the
 * plan file's §13 PARKED block. Everything in this module is intentionally
 * provider-agnostic.
 */
import type { TransactionSql } from 'postgres';

/**
 * Spec §13 trust tiers. The schema doesn't ship a tier column yet, so the
 * default is 'new' until WS-9 lands the composite trust score.
 */
export type TrustTier = 'new' | 'bronze' | 'silver' | 'gold' | 'platinum';

export type LedgerAccountType =
  | 'user_wallet'
  | 'platform_revenue'
  | 'escrow'
  | 'stripe_clearing'
  | 'refund_reserve';

export type LedgerCategory =
  | 'deposit'
  | 'match_escrow'
  | 'match_payout'
  | 'platform_fee'
  | 'withdrawal'
  | 'refund'
  | 'reversal';

export type LedgerReferenceType = 'match' | 'stripe_payment' | 'payout' | 'manual';

export interface LedgerLine {
  accountType: LedgerAccountType;
  /** NULL for platform-owned accounts (escrow, platform_revenue, …). */
  accountId: string | null;
  direction: 'D' | 'C';
  amountCents: number;
  currency: string;
  category: LedgerCategory;
  referenceType: LedgerReferenceType | null;
  referenceId: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Withdrawal hold periods per spec §13. Returned as days; UI formats them
 * as "T+N". 'new' / 'bronze' both get 5 days (the spec collapses them to
 * "low-trust"); silver gets 3; gold gets 1; platinum is immediate.
 */
export function walletHoldPeriodDays(tier: TrustTier): number {
  switch (tier) {
    case 'new':
    case 'bronze':
      return 5;
    case 'silver':
      return 3;
    case 'gold':
      return 1;
    case 'platinum':
      return 0;
  }
}

export class UnbalancedTransactionError extends Error {
  constructor(
    public readonly transactionId: string,
    public readonly currency: string,
    public readonly debits: number,
    public readonly credits: number,
  ) {
    super(`unbalanced ledger transaction ${transactionId} (${currency}): D=${debits} C=${credits}`);
  }
}

/**
 * Write a single ledger transaction. Throws synchronously on imbalance —
 * the tx rolls back and no rows persist.
 *
 * Invariants enforced:
 *   1. lines.length >= 2
 *   2. for each currency in the transaction, SUM(D) === SUM(C)
 *   3. every amountCents is strictly positive
 *
 * The CHECK constraint on `ledger_entries.amount_cents` is also positive-
 * only; this helper rejects zero-amount lines so a partial accidental
 * commit can't sneak through.
 */
export async function postLedgerTransaction(
  tx: TransactionSql<Record<string, never>>,
  args: { transactionId: string; lines: LedgerLine[]; reversibleUntil?: string | null },
): Promise<void> {
  const { transactionId, lines } = args;
  if (lines.length < 2) {
    throw new Error(`ledger transaction ${transactionId}: must have ≥2 lines`);
  }
  const byCurrency = new Map<string, { debits: number; credits: number }>();
  for (const line of lines) {
    if (!Number.isFinite(line.amountCents) || line.amountCents <= 0) {
      throw new Error(
        `ledger transaction ${transactionId}: amountCents must be > 0 (got ${line.amountCents})`,
      );
    }
    const bucket = byCurrency.get(line.currency) ?? { debits: 0, credits: 0 };
    if (line.direction === 'D') bucket.debits += line.amountCents;
    else bucket.credits += line.amountCents;
    byCurrency.set(line.currency, bucket);
  }
  for (const [currency, { debits, credits }] of byCurrency) {
    if (debits !== credits) {
      throw new UnbalancedTransactionError(transactionId, currency, debits, credits);
    }
  }

  for (const line of lines) {
    await tx`
      INSERT INTO ledger_entries (
        transaction_id, account_type, account_id, direction, amount_cents,
        currency, category, reference_type, reference_id,
        reversible_until, metadata
      ) VALUES (
        ${transactionId}::uuid,
        ${line.accountType},
        ${line.accountId},
        ${line.direction},
        ${line.amountCents},
        ${line.currency},
        ${line.category},
        ${line.referenceType},
        ${line.referenceId},
        ${args.reversibleUntil ?? null},
        ${line.metadata ? JSON.stringify(line.metadata) : null}
      )
    `;
  }
}

/**
 * Builder: match escrow debit. Creator's wallet → escrow account.
 * One transaction, two balancing lines.
 */
export function buildMatchEscrowLines(args: {
  creatorProfileId: string;
  matchId: string;
  feeCents: number;
  currency?: string;
}): LedgerLine[] {
  const currency = args.currency ?? 'USD';
  return [
    {
      accountType: 'user_wallet',
      accountId: args.creatorProfileId,
      direction: 'D',
      amountCents: args.feeCents,
      currency,
      category: 'match_escrow',
      referenceType: 'match',
      referenceId: args.matchId,
    },
    {
      accountType: 'escrow',
      accountId: null,
      direction: 'C',
      amountCents: args.feeCents,
      currency,
      category: 'match_escrow',
      referenceType: 'match',
      referenceId: args.matchId,
    },
  ];
}

/**
 * Builder: match settlement. Escrow → opponent payout + platform fee.
 * Single transaction; three balancing lines: D escrow (full fee), C
 * opponent (payout share), C platform_revenue (fee share). Payout +
 * platform shares must sum to the full fee.
 */
export function buildMatchSettlementLines(args: {
  opponentProfileId: string;
  matchId: string;
  feeCents: number;
  opponentPayoutCents: number;
  platformFeeCents: number;
  currency?: string;
}): LedgerLine[] {
  const currency = args.currency ?? 'USD';
  if (args.opponentPayoutCents + args.platformFeeCents !== args.feeCents) {
    throw new Error(
      `match ${args.matchId}: payout (${args.opponentPayoutCents}) + platform fee (${args.platformFeeCents}) ` +
        `must equal escrow (${args.feeCents})`,
    );
  }
  return [
    {
      accountType: 'escrow',
      accountId: null,
      direction: 'D',
      amountCents: args.feeCents,
      currency,
      category: 'match_payout',
      referenceType: 'match',
      referenceId: args.matchId,
    },
    {
      accountType: 'user_wallet',
      accountId: args.opponentProfileId,
      direction: 'C',
      amountCents: args.opponentPayoutCents,
      currency,
      category: 'match_payout',
      referenceType: 'match',
      referenceId: args.matchId,
    },
    {
      accountType: 'platform_revenue',
      accountId: null,
      direction: 'C',
      amountCents: args.platformFeeCents,
      currency,
      category: 'platform_fee',
      referenceType: 'match',
      referenceId: args.matchId,
    },
  ];
}

/**
 * Builder: refund. Escrow → creator wallet. Used for opponent-abandoned
 * + technical-failure resolutions per spec §11. Caller decides whether
 * to refund the full fee (typical) or a partial fee.
 */
export function buildRefundLines(args: {
  creatorProfileId: string;
  matchId: string;
  refundCents: number;
  currency?: string;
}): LedgerLine[] {
  const currency = args.currency ?? 'USD';
  return [
    {
      accountType: 'escrow',
      accountId: null,
      direction: 'D',
      amountCents: args.refundCents,
      currency,
      category: 'refund',
      referenceType: 'match',
      referenceId: args.matchId,
    },
    {
      accountType: 'user_wallet',
      accountId: args.creatorProfileId,
      direction: 'C',
      amountCents: args.refundCents,
      currency,
      category: 'refund',
      referenceType: 'match',
      referenceId: args.matchId,
    },
  ];
}

/**
 * Builder: withdrawal. User wallet → external payout clearing account.
 * The provider integration (Stripe Connect / Paddle) replaces the
 * stripe_clearing account on its side; until then, this builder is wired
 * but the route that calls it returns 503 (see /api/account/wallet/withdraw).
 */
export function buildWithdrawalLines(args: {
  profileId: string;
  payoutId: string;
  amountCents: number;
  currency?: string;
}): LedgerLine[] {
  const currency = args.currency ?? 'USD';
  return [
    {
      accountType: 'user_wallet',
      accountId: args.profileId,
      direction: 'D',
      amountCents: args.amountCents,
      currency,
      category: 'withdrawal',
      referenceType: 'payout',
      referenceId: args.payoutId,
    },
    {
      accountType: 'stripe_clearing',
      accountId: null,
      direction: 'C',
      amountCents: args.amountCents,
      currency,
      category: 'withdrawal',
      referenceType: 'payout',
      referenceId: args.payoutId,
    },
  ];
}

/**
 * Reconciliation: per-currency, every account_type's net balance.
 *
 *   Invariants we expect at end-of-day:
 *     - SUM(escrow D) - SUM(escrow C) == SUM(wallets.pending_cents)
 *     - SUM(platform_revenue C) - SUM(platform_revenue D) >= 0
 *     - SUM(user_wallet C) - SUM(user_wallet D) ≈ SUM(wallets.available_cents)
 *       (modulo intra-day pending balances that haven't moved yet)
 *
 * The reconcile script (apps/workers/src/reconcile/ledger.ts) calls this
 * and exits non-zero on mismatch.
 */
export interface AccountTypeNet {
  accountType: LedgerAccountType;
  currency: string;
  debits: number;
  credits: number;
  net: number;
}

export interface ReconciliationResult {
  generatedAt: string;
  perAccountType: AccountTypeNet[];
  escrowMatchesPending: boolean;
  escrowNet: number;
  walletPendingTotal: number;
}

export async function reconcileLedger(
  sql: TransactionSql<Record<string, never>>,
): Promise<ReconciliationResult> {
  type Row = { account_type: LedgerAccountType; currency: string; debits: string; credits: string };
  const accountRows = await sql<Row[]>`
    SELECT
      account_type,
      currency,
      COALESCE(SUM(amount_cents) FILTER (WHERE direction = 'D'), 0)::text AS debits,
      COALESCE(SUM(amount_cents) FILTER (WHERE direction = 'C'), 0)::text AS credits
    FROM ledger_entries
    GROUP BY account_type, currency
  `;
  const perAccountType: AccountTypeNet[] = accountRows.map((r) => {
    const d = Number(r.debits);
    const c = Number(r.credits);
    return {
      accountType: r.account_type,
      currency: r.currency,
      debits: d,
      credits: c,
      // For escrow + stripe_clearing we want C - D (money held); for
      // user_wallet we want C - D (money owed to users); for
      // platform_revenue same. All accounts in this system normally
      // net positive on the credit side from the perspective of
      // "money owed somewhere", so we use C - D uniformly.
      net: c - d,
    };
  });
  const escrowRow = perAccountType.find((r) => r.accountType === 'escrow');
  const escrowNet = escrowRow?.net ?? 0;
  const walletPendingRows = await sql<{ total: string }[]>`
    SELECT COALESCE(SUM(pending_cents), 0)::text AS total FROM wallets
  `;
  const walletPendingTotal = Number(walletPendingRows[0]?.total ?? 0);
  return {
    generatedAt: new Date().toISOString(),
    perAccountType,
    escrowMatchesPending: escrowNet === walletPendingTotal,
    escrowNet,
    walletPendingTotal,
  };
}
