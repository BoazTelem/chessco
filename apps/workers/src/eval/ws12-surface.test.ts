/**
 * WS-12 final audit — bots + coach surface.
 *
 *   pnpm --filter @chessco/workers exec tsx src/eval/ws12-surface.test.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
function read(rel: string): string {
  return readFileSync(pathResolve(REPO_ROOT, rel), 'utf8');
}
function exists(rel: string): boolean {
  return existsSync(pathResolve(REPO_ROOT, rel));
}

let failures = 0;
function expect(label: string, ok: boolean, detail: string): void {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label} — ${detail}`);
  }
}

console.log('maia_weights schema');
{
  const schema = read('packages/db/src/schema.ts');
  expect('table declared', /pgTable\(\s*['"]maia_weights['"]/.test(schema), 'maia_weights missing');
  expect(
    'status enum: queued / training / ready / failed / deprecated',
    /'queued'\s*\|\s*'training'\s*\|\s*'ready'\s*\|\s*'failed'\s*\|\s*'deprecated'/.test(schema),
    'status enum drifted',
  );
  expect(
    'dataset_hash column (skip retraining on unchanged data)',
    /dataset_hash/.test(schema),
    'dataset_hash missing',
  );
  expect(
    'indexes on target_profile_id and target_player_id (status partial filter)',
    /maia_weights_target_profile_idx/.test(schema) && /maia_weights_target_player_idx/.test(schema),
    'maia_weights indexes drifted',
  );
}

console.log('\nmaia/inference.ts');
{
  const src = read('apps/web/lib/maia/inference.ts');
  expect(
    'exports getBotMove',
    /export\s+async\s+function\s+getBotMove/.test(src),
    'getBotMove missing',
  );
  expect(
    'outcome union: ok / transport_unconfigured / transport_error / weights_not_ready',
    /'transport_unconfigured'/.test(src) &&
      /'transport_error'/.test(src) &&
      /'weights_not_ready'/.test(src),
    'outcome union drifted',
  );
  expect('8s request timeout', /REQUEST_TIMEOUT_MS\s*=\s*8_000/.test(src), 'timeout drifted');
  expect(
    '409 weights-not-ready convention',
    /resp\.status === 409/.test(src),
    '409 handling missing',
  );
}

console.log('\npages');
{
  expect('drill page exists', exists('apps/web/app/practice/drill/page.tsx'), 'missing');
  expect('sandbox page exists', exists('apps/web/app/practice/sandbox/page.tsx'), 'missing');
  expect('coach students list exists', exists('apps/web/app/coach/students/page.tsx'), 'missing');
  expect(
    'coach student detail exists',
    exists('apps/web/app/coach/students/[id]/page.tsx'),
    'missing',
  );
  expect('OTB prep page exists', exists('apps/web/app/prepare/otb/page.tsx'), 'missing');

  const coachList = read('apps/web/app/coach/students/page.tsx');
  expect(
    'coach list orders by status (active → pending → ended)',
    /CASE cs\.status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END/.test(coachList),
    'coach status ordering drifted',
  );
  const coachDetail = read('apps/web/app/coach/students/[id]/page.tsx');
  expect(
    'student detail gated on coach_students relationship',
    /FROM coach_students/.test(coachDetail) && /coach_profile_id = \$\{coachId\}/.test(coachDetail),
    'coach detail auth gate missing',
  );
  const drill = read('apps/web/app/practice/drill/page.tsx');
  expect(
    'drill page surfaces MAIA_INFERENCE_URL gating',
    /MAIA_INFERENCE_URL/.test(drill),
    'drill MAIA env gate missing',
  );
}

console.log('\ncontract docs');
{
  expect('MAIA-INFERENCE.md exists', exists('docs/MAIA-INFERENCE.md'), 'missing');
  expect('SPECTATOR.md exists', exists('docs/SPECTATOR.md'), 'missing');
  const maia = read('docs/MAIA-INFERENCE.md');
  expect(
    'inference contract defines POST /move endpoint',
    /POST \{MAIA_INFERENCE_URL\}\/move/.test(maia),
    'POST /move documented endpoint drifted',
  );
  const spectator = read('docs/SPECTATOR.md');
  expect(
    'spectator delay is 10 plies by default',
    /10 by default/.test(spectator),
    'default delay drifted',
  );
  expect(
    'silver+ verified gets no delay',
    /0 for verified silver\+/.test(spectator),
    'silver+ exception drifted',
  );
}

if (failures > 0) {
  console.error(`\n${failures} WS-12 audit(s) failed`);
  process.exit(1);
} else {
  console.log('\nall ws12-surface.test.ts audits passed');
}
