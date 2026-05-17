# Runbook — daily finance reconciliation

**When** the daily `pnpm reconcile:ledger` job exits non-zero, or an alert fires on the reconciliation mismatch metric.

**Goal** restore the invariant `SUM(escrow C-D) === SUM(wallets.pending_cents)` within the same business day. Spec §13 launch gate requires 7 consecutive clean days.

## Steps

1.  Re-run interactively to see the current diff:

        pnpm --filter @chessco/workers reconcile:ledger

    Exit 0 = clean. Exit 1 = escrow vs pending mismatch (the usual case). Exit 2 = negative aggregate (likely bug). Exit 3 = DB unreachable.

2.  If exit 1, identify the drift source. Common causes:
    - A match settled via the inline accept route ([accept/route.ts:130](apps/web/app/api/practice/challenges/[id]/accept/route.ts)) but the wallet `pending_cents` decrement didn't fire. Compare:

          SELECT m.id, m.fee_cents, m.status, m.created_at,
                 lg.status AS live_status, lg.started_at
          FROM matches m
          LEFT JOIN live_games lg ON lg.match_id = m.id
          WHERE m.created_at > NOW() - INTERVAL '24 hours'
          ORDER BY m.created_at DESC;

    - A refund was applied at the route level but not via `buildRefundLines`. Look for `category = 'refund'` in `ledger_entries` and confirm both legs exist.

    - A manual admin adjustment was made (`audit_logs.action = 'wallet.adjust'`) without a paired ledger row.

3.  Apply the correction transactionally. Use `postLedgerTransaction` directly (not raw inserts) so balance is enforced:

    // Pseudo — adjust to real values:
    // postLedgerTransaction(tx, {
    // transactionId: crypto.randomUUID(),
    // lines: [
    // { accountType: 'user_wallet', accountId: '...', direction: 'D|C', ... },
    // { accountType: 'escrow', accountId: null, direction: opposite, ... },
    // ],
    // });

4.  Re-run reconcile; confirm exit 0.

5.  Audit log the correction with the source of drift and what was posted.

## Verify

- `reconcile:ledger` exits 0.
- The "7-consecutive-clean-days" counter (tracked externally — Metabase tile) reflects the fresh clean run.

## Escalate

- Cannot identify the drift source: pause new paid challenge accepts via feature flag; do not unpark billing.
- Drift exceeds $50: notify finance + legal before correcting.
- Recurring drift on the same code path: open a bug + add a regression test to `apps/workers/src/eval/ledger-lib.test.ts` style audit.
