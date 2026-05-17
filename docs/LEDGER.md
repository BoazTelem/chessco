# Ledger semantics (spec §13, WS-8)

Provider-agnostic. Stripe-vs-Paddle decision is parked; everything below is independent of that choice and survives whichever provider lands.

---

## Tables

| Table                   | Purpose                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `wallets`               | Per-profile rolled-up balance (available + pending; cash + credits).                  |
| `ledger_entries`        | Cash double-entry rows. Every transaction must balance D=C per currency.              |
| `credit_ledger_entries` | Credits-side single-entry log (credits are a closed economy; no double-entry needed). |
| `credit_grants`         | Audit of credit issuance for reconcilation and anti-abuse caps.                       |
| `stripe_events`         | Provider webhook idempotency log. Inert until provider lands.                         |

---

## Library: `apps/web/lib/ledger.ts`

All cash mutations should flow through `postLedgerTransaction(tx, { transactionId, lines })`. The library enforces:

1. **At least two lines per transaction.**
2. **Balanced per currency.** For every currency in the transaction, `SUM(direction='D') === SUM(direction='C')`. An unbalanced transaction throws `UnbalancedTransactionError` and the surrounding `tx` rolls back.
3. **Positive amounts only.** Zero or negative `amountCents` rejected synchronously.

Builders cover the four lifecycle moments:

- `buildMatchEscrowLines` — D creator user_wallet, C escrow. Called at match accept.
- `buildMatchSettlementLines` — D escrow, C opponent user_wallet, C platform_revenue. The split must equal escrow.
- `buildRefundLines` — D escrow, C creator user_wallet. Spec §11 categorical reasons drive whether to call this.
- `buildWithdrawalLines` — D user_wallet, C stripe_clearing. Wired but the calling route returns 503 until billing lands.

---

## Withdrawal hold periods (spec §13)

`walletHoldPeriodDays(tier)` returns:

| Tier     | Hold (days) |
| -------- | ----------- |
| new      | 5           |
| bronze   | 5           |
| silver   | 3           |
| gold     | 1           |
| platinum | 0           |

The trust tier column on `profiles` lands in WS-9. Until then, the wallet UI defaults to `'new'` so the conservative number renders.

---

## Daily reconciliation

    pnpm --filter @chessco/workers reconcile:ledger
    pnpm --filter @chessco/workers reconcile:ledger -- --json   # for cron consumers

Exit codes:

| Code | Meaning                                               |
| ---- | ----------------------------------------------------- |
| 0    | Clean. Escrow C-D equals `SUM(wallets.pending_cents)` |
| 1    | Escrow vs pending mismatch                            |
| 2    | Per-account-type negative aggregate (bug indicator)   |
| 3    | DB unreachable                                        |

The reconcile job is the basis of the Phase 4 launch gate: 7 consecutive clean runs before the billing block is unparked.

---

## Inlined-write deprecation path

The existing route at [apps/web/app/api/practice/challenges/[id]/accept/route.ts](apps/web/app/api/practice/challenges/[id]/accept/route.ts) inlines the escrow `INSERT INTO ledger_entries`. It still works (and the lib accepts the same shape), but new callers MUST use `postLedgerTransaction` so the invariants get enforced. The accept route migrates to the lib in a follow-up; this WS keeps it untouched to limit blast radius.

---

## When billing unparks

After Stripe vs. Paddle is decided:

1. Add the provider-specific deposit endpoint that calls `postLedgerTransaction` with `category: 'deposit'`, D `stripe_clearing` C `user_wallet`.
2. Wire the withdrawal payout call to the provider; mark the existing `buildWithdrawalLines` transaction as `reversible_until = NOW() + interval '7 days'`.
3. Add a webhook idempotency check via `stripe_events.id` so retried provider POSTs do not double-credit.
4. Update `/account/wallet/page.tsx` to enable the Deposit/Withdraw CTAs.
