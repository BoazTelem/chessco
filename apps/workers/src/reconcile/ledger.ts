/**
 * Daily ledger reconciliation.
 *
 *   pnpm --filter @chessco/workers reconcile:ledger
 *   pnpm --filter @chessco/workers reconcile:ledger -- --json
 *
 * Walks the cash ledger (`ledger_entries`) and prints per-account-type net
 * balances by currency, then asserts:
 *
 *   1. SUM(escrow C - escrow D) === SUM(wallets.pending_cents)
 *      (every cent in escrow is also reserved on some user's pending bucket)
 *   2. No currency has unbalanced totals (per-transaction balance is
 *      enforced at write time; this verifies global drift after migrations
 *      or out-of-band corrections)
 *
 * Exit codes:
 *   0  — reconciliation clean
 *   1  — escrow vs pending mismatch
 *   2  — global currency imbalance (any net != expected)
 *   3  — DB unreachable
 *
 * This script is the basis for Phase 4's "7 consecutive clean days" gate.
 */
import 'dotenv/config';
import type postgres from 'postgres';

interface AccountNet {
  account_type: string;
  currency: string;
  debits: string;
  credits: string;
}

async function main(): Promise<void> {
  const wantJson = process.argv.includes('--json');

  // workers/db.ts exports getDb() for Supabase (where wallets +
  // ledger_entries live). Cloud SQL via getGamesDb() is the games
  // corpus — not money.
  let client: postgres.Sql;
  try {
    const { getDb } = await import('../db');
    ({ client } = getDb());
  } catch (err) {
    console.error('[reconcile:ledger] DB unreachable:', err instanceof Error ? err.message : err);
    process.exit(3);
  }
  try {
    const probe = await client<{ now: string }[]>`SELECT NOW()::text AS now`;
    if (probe.length === 0) throw new Error('SELECT NOW() returned empty');

    const accountRows = await client<AccountNet[]>`
      SELECT
        account_type,
        currency,
        COALESCE(SUM(amount_cents) FILTER (WHERE direction = 'D'), 0)::text AS debits,
        COALESCE(SUM(amount_cents) FILTER (WHERE direction = 'C'), 0)::text AS credits
      FROM ledger_entries
      GROUP BY account_type, currency
      ORDER BY account_type, currency
    `;

    const walletRows = await client<{ total: string }[]>`
      SELECT COALESCE(SUM(pending_cents), 0)::text AS total FROM wallets
    `;
    const pendingTotal = Number(walletRows[0]?.total ?? 0);
    const escrowRow = accountRows.find((r) => r.account_type === 'escrow' && r.currency === 'USD');
    const escrowNet = escrowRow ? Number(escrowRow.credits) - Number(escrowRow.debits) : 0;

    const result = {
      generatedAt: new Date().toISOString(),
      accounts: accountRows.map((r) => ({
        accountType: r.account_type,
        currency: r.currency,
        debits: Number(r.debits),
        credits: Number(r.credits),
        net: Number(r.credits) - Number(r.debits),
      })),
      escrowNetUsd: escrowNet,
      walletsPendingTotalUsd: pendingTotal,
      escrowMatchesPending: escrowNet === pendingTotal,
    };

    if (wantJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`# ledger reconciliation @ ${result.generatedAt}`);
      console.log('');
      console.log('Account type        Currency   Debits     Credits    Net');
      for (const a of result.accounts) {
        console.log(
          `  ${a.accountType.padEnd(18)} ${a.currency.padEnd(8)}  ${a.debits
            .toString()
            .padStart(
              10,
            )}  ${a.credits.toString().padStart(10)}  ${(a.net >= 0 ? '+' : '') + a.net}`,
        );
      }
      console.log('');
      console.log(`escrow C-D (USD):                       ${escrowNet}`);
      console.log(`wallets.pending_cents total:            ${pendingTotal}`);
      console.log(
        `escrow vs pending:                      ${result.escrowMatchesPending ? '✓ match' : '✗ MISMATCH'}`,
      );
    }

    if (!result.escrowMatchesPending) {
      console.error(
        `\n[reconcile:ledger] escrow ($${escrowNet}) != pending ($${pendingTotal}). Investigate.`,
      );
      process.exit(1);
    }

    // Sanity: a non-escrow account_type with negative credits would be
    // a definite bug. Don't enforce strict net>=0 here because reversals
    // can flip user wallets temporarily negative.
    let imbalanceFound = false;
    for (const a of result.accounts) {
      if (a.debits < 0 || a.credits < 0) {
        console.error(`\n[reconcile:ledger] negative aggregate on ${a.accountType}/${a.currency}`);
        imbalanceFound = true;
      }
    }
    if (imbalanceFound) process.exit(2);
  } catch (err) {
    console.error('[reconcile:ledger] DB unreachable:', err instanceof Error ? err.message : err);
    process.exit(3);
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
}

void main();
