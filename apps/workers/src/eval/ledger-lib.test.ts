/**
 * Static audit of apps/web/lib/ledger.ts (WS-8 contract lock).
 *
 *   pnpm --filter @chessco/workers exec tsx src/eval/ledger-lib.test.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const LIB_PATH = pathResolve(REPO_ROOT, 'apps/web/lib/ledger.ts');

let failures = 0;
function expect(label: string, ok: boolean, detail: string): void {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label} — ${detail}`);
  }
}

const src = readFileSync(LIB_PATH, 'utf8');

console.log('ledger.ts public surface');
expect(
  'exports postLedgerTransaction',
  /export\s+async\s+function\s+postLedgerTransaction\b/.test(src),
  'postLedgerTransaction missing',
);
expect(
  'exports walletHoldPeriodDays',
  /export\s+function\s+walletHoldPeriodDays\b/.test(src),
  'walletHoldPeriodDays missing',
);
expect(
  'exports buildMatchEscrowLines',
  /export\s+function\s+buildMatchEscrowLines\b/.test(src),
  'buildMatchEscrowLines missing',
);
expect(
  'exports buildMatchSettlementLines',
  /export\s+function\s+buildMatchSettlementLines\b/.test(src),
  'buildMatchSettlementLines missing',
);
expect(
  'exports buildRefundLines',
  /export\s+function\s+buildRefundLines\b/.test(src),
  'buildRefundLines missing',
);
expect(
  'exports buildWithdrawalLines',
  /export\s+function\s+buildWithdrawalLines\b/.test(src),
  'buildWithdrawalLines missing',
);
expect(
  'exports reconcileLedger',
  /export\s+async\s+function\s+reconcileLedger\b/.test(src),
  'reconcileLedger missing',
);

console.log('\ndouble-entry invariants');
expect(
  'rejects unbalanced transactions',
  /UnbalancedTransactionError/.test(src) && /debits\s*!==\s*credits/.test(src),
  'no balance check found',
);
expect(
  'rejects non-positive amountCents',
  /amountCents must be > 0/.test(src),
  'positive-amount guard missing',
);
expect(
  'requires >=2 lines per transaction',
  /must have ≥2 lines/.test(src),
  'minimum-lines guard missing',
);

console.log('\nspec §13 hold periods');
expect(
  'new/bronze → T+5',
  /case 'new':[\s\S]{0,80}case 'bronze':[\s\S]{0,40}return 5/.test(src),
  'new/bronze hold drift',
);
expect('silver → T+3', /case 'silver':[\s\S]{0,40}return 3/.test(src), 'silver hold drift');
expect(
  'gold → T+1, platinum → T+0',
  /case 'gold':[\s\S]{0,40}return 1[\s\S]{0,80}case 'platinum':[\s\S]{0,40}return 0/.test(src),
  'gold/platinum hold drift',
);

console.log('\nsettlement builder splits correctly');
expect(
  'enforces payout + platform = escrow on settlement',
  /opponentPayoutCents\s*\+\s*args\.platformFeeCents\s*!==\s*args\.feeCents/.test(src),
  'split invariant missing',
);

if (failures > 0) {
  console.error(`\n${failures} ledger-lib audit(s) failed`);
  process.exit(1);
} else {
  console.log('\nall ledger-lib.test.ts audits passed');
}
