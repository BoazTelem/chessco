/**
 * Static schema audit for marketplace tables (spec §8).
 *
 * Locks the presence of the three tables WS-7 added to
 * packages/db/src/schema.ts so a future refactor can't quietly delete them.
 *
 *   pnpm --filter @chessco/workers exec tsx src/eval/marketplace-schema.test.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCHEMA_PATH = pathResolve(REPO_ROOT, 'packages/db/src/schema.ts');

let failures = 0;
function expect(label: string, ok: boolean, detail: string): void {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label} — ${detail}`);
  }
}

const src = readFileSync(SCHEMA_PATH, 'utf8');

console.log('marketplace tables');
expect(
  'challenge_invitations table',
  /pgTable\(\s*['"]challenge_invitations['"]/.test(src),
  'challenge_invitations table missing',
);
expect(
  'player_sparring_profiles table',
  /pgTable\(\s*['"]player_sparring_profiles['"]/.test(src),
  'player_sparring_profiles table missing',
);
expect(
  'player_sparring_fees table',
  /pgTable\(\s*['"]player_sparring_fees['"]/.test(src),
  'player_sparring_fees table missing',
);

console.log('\nchallenge_invitations contract');
expect(
  'invitation status enum (pending / accepted / declined / withdrawn / expired)',
  /'pending'\s*\|\s*'accepted'\s*\|\s*'declined'\s*\|\s*'withdrawn'\s*\|\s*'expired'/.test(src),
  'status enum drifted from spec §8',
);
expect(
  'inviter + invitee FK to profiles',
  /inviter_id[\s\S]{0,200}references\([^)]*\)\s*=>\s*profiles\.id/.test(src) &&
    /invitee_id[\s\S]{0,200}references\([^)]*\)\s*=>\s*profiles\.id/.test(src),
  'inviter/invitee FK references changed',
);

console.log('\nplayer_sparring_profiles contract');
expect('opted_in flag exists', /boolean\(['"]opted_in['"]\)/.test(src), 'opted_in column missing');
expect(
  'away_until exists',
  /timestamptz\(['"]away_until['"]\)/.test(src),
  'away_until column missing',
);
expect(
  'profile_id is the primary key (1:1 with profiles)',
  /profileId:\s*uuid\('profile_id'\)\s*\n?\s*\.primaryKey\(\)/.test(src),
  'profile_id PK contract changed',
);

console.log('\nplayer_sparring_fees contract');
expect(
  'fees keyed by (profile, time_class) unique index',
  /player_sparring_fees_profile_time_class_unique/.test(src),
  'unique index missing — upsert by (profile, time_class) breaks',
);
expect(
  'funding_type enum includes either / cash / credits',
  /'cash'\s*\|\s*'credits'\s*\|\s*'either'/.test(src),
  'funding_type enum drifted',
);

if (failures > 0) {
  console.error(`\n${failures} marketplace-schema audit(s) failed`);
  process.exit(1);
} else {
  console.log('\nall marketplace-schema.test.ts audits passed');
}
