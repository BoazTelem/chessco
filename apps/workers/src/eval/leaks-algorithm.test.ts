/**
 * Static API-surface audit for the leak scorer (CQ-2).
 *
 * Runtime behavioural testing of scoreLeaks() lives in production via
 * `apps/workers/scripts/leaks-smoke.ts` (real DB + real opponents). Doing
 * a cross-package runtime import from this worker into apps/web's lib
 * tree fails because apps/web is not "type":"module"; the integration
 * cost of fixing that doesn't pay off here.
 *
 * Instead, this script:
 *   1. Loads apps/web/lib/leaks/score.ts as text.
 *   2. Asserts the file exports the public surface that the prep pipeline
 *      depends on (scoreLeaks, scoreOwnLeaks).
 *   3. Asserts the LeakKind enum in apps/web/lib/leaks/types.ts still
 *      enumerates the three cohorts the report UI renders.
 *
 * Drift in either file flips one of these checks to fail at PR time
 * — that's the lock the CQ-2 datasets depend on once B6/B7 land.
 *
 *   pnpm --filter @chessco/workers exec tsx src/eval/leaks-algorithm.test.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCORE_PATH = pathResolve(REPO_ROOT, 'apps/web/lib/leaks/score.ts');
const TYPES_PATH = pathResolve(REPO_ROOT, 'apps/web/lib/leaks/types.ts');

let failures = 0;
function expect(label: string, ok: boolean, detail: string): void {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label} — ${detail}`);
  }
}

const score = readFileSync(SCORE_PATH, 'utf8');
const types = readFileSync(TYPES_PATH, 'utf8');

console.log('scoreLeaks public surface');
expect(
  'exports scoreLeaks',
  /export\s+function\s+scoreLeaks\s*\(/.test(score),
  'no `export function scoreLeaks` found',
);
expect(
  'exports scoreOwnLeaks (recommended-lines-to-avoid path)',
  /export\s+function\s+scoreOwnLeaks\s*\(/.test(score),
  'no `export function scoreOwnLeaks` found',
);
expect(
  'normalizes FEN to first-4-fields (transposition safety)',
  /split\(' '\)\.slice\(0,\s*4\)/.test(score),
  'FEN normalization changed — transposition safety could regress',
);
expect(
  'emits both personalized and surprise cohorts',
  /'personalized'/.test(score) && /'surprise'/.test(score),
  'cohort literal strings missing',
);

console.log('\nLeakKind enum lock');
expect(
  'LeakKind union contains personalized | surprise | own',
  /LeakKind\s*=\s*'personalized'\s*\|\s*'surprise'\s*\|\s*'own'/.test(types),
  'LeakKind union shape drifted',
);
expect(
  'Leak.kind field declared',
  /\bkind:\s*LeakKind\b/.test(types),
  'Leak.kind field declaration not found',
);

console.log('\nScoreOptions surface');
expect(
  'ScoreOptions exposes userColor + maxPersonalized + maxSurprise',
  /userColor:\s*Color/.test(types) &&
    /maxPersonalized\?:/.test(types) &&
    /maxSurprise\?:/.test(types),
  'ScoreOptions shape changed',
);

if (failures > 0) {
  console.error(`\n${failures} leak-algorithm audit(s) failed`);
  process.exit(1);
} else {
  console.log('\nall leaks-algorithm.test.ts audits passed');
}
