/**
 * WS-10 schema audit — ban_actions + coach_students.
 *
 *   pnpm --filter @chessco/workers exec tsx src/eval/ws10-schema.test.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCHEMA = readFileSync(pathResolve(REPO_ROOT, 'packages/db/src/schema.ts'), 'utf8');

let failures = 0;
function expect(label: string, ok: boolean, detail: string): void {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label} — ${detail}`);
  }
}

console.log('ban_actions');
expect(
  'table declared',
  /pgTable\(\s*['"]ban_actions['"]/.test(SCHEMA),
  'ban_actions table missing',
);
expect(
  'severity column is integer (spec §12 ladder 1-6)',
  /severity:\s*integer\(['"]severity['"]\)\.notNull\(\)/.test(SCHEMA),
  'severity column shape drifted',
);
expect(
  'evidence column is jsonb',
  /evidence:\s*jsonb\(['"]evidence['"]\)/.test(SCHEMA),
  'evidence column drifted',
);
expect(
  'reversedBy + reversedAt for appeal reversal',
  /reversedAt:\s*timestamptz\(['"]reversed_at['"]\)/.test(SCHEMA) &&
    /reversedBy:\s*uuid\(['"]reversed_by['"]\)/.test(SCHEMA),
  'reversal fields missing',
);

console.log('\ncoach_students');
expect(
  'table declared',
  /pgTable\(\s*['"]coach_students['"]/.test(SCHEMA),
  'coach_students table missing',
);
expect(
  'unique on (coach_profile_id, student_profile_id)',
  /coach_students_pair_unique/.test(SCHEMA),
  'unique index missing',
);
expect(
  'status enum: pending / active / ended',
  /'pending'\s*\|\s*'active'\s*\|\s*'ended'/.test(SCHEMA),
  'status enum drifted',
);

console.log('\ndocs structure');
{
  const runbooks = [
    'docs/runbooks/README.md',
    'docs/runbooks/fide-ingestion.md',
    'docs/runbooks/engine-cheating-investigation.md',
    'docs/runbooks/account-takeover.md',
    'docs/runbooks/gdpr-data-request.md',
    'docs/runbooks/account-deletion.md',
    'docs/runbooks/database-restore.md',
    'docs/runbooks/incident-response.md',
    'docs/runbooks/daily-finance-reconciliation.md',
  ];
  for (const path of runbooks) {
    const exists = (() => {
      try {
        readFileSync(pathResolve(REPO_ROOT, path));
        return true;
      } catch {
        return false;
      }
    })();
    expect(`runbook present: ${path.replace('docs/runbooks/', '')}`, exists, 'file missing');
  }
  const legal = [
    'docs/legal/README.md',
    'docs/legal/terms.md',
    'docs/legal/privacy.md',
    'docs/legal/refund-policy.md',
    'docs/legal/fairplay-policy.md',
    'docs/legal/acceptable-use.md',
    'docs/legal/cookie-policy.md',
    'docs/legal/dpa.md',
  ];
  for (const path of legal) {
    const exists = (() => {
      try {
        readFileSync(pathResolve(REPO_ROOT, path));
        return true;
      } catch {
        return false;
      }
    })();
    expect(`legal draft present: ${path.replace('docs/legal/', '')}`, exists, 'file missing');
  }
}

if (failures > 0) {
  console.error(`\n${failures} WS-10 audit(s) failed`);
  process.exit(1);
} else {
  console.log('\nall ws10-schema.test.ts audits passed');
}
