/**
 * WS-11 surface audit — anti-cheat libraries + routes.
 *
 *   pnpm --filter @chessco/workers exec tsx src/eval/ws11-libs.test.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
function read(rel: string): string {
  return readFileSync(pathResolve(REPO_ROOT, rel), 'utf8');
}

let failures = 0;
function expect(label: string, ok: boolean, detail: string): void {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label} — ${detail}`);
  }
}

console.log('baselines.ts');
{
  const src = read('apps/web/lib/fairplay/baselines.ts');
  expect(
    'exports baselineForRating',
    /export\s+function\s+baselineForRating/.test(src),
    'baselineForRating missing',
  );
  expect(
    'table descends from 2700+ to 0',
    /minRating: 2700/.test(src) && /minRating: 0/.test(src),
    'baseline table edge bands missing',
  );
  expect(
    'p99 monotone-increasing with rating',
    /p99: 0\.85/.test(src) && /p99: 0\.46/.test(src),
    'p99 spread drifted',
  );
}

console.log('\nengine-correlation.ts');
{
  const src = read('apps/web/lib/fairplay/engine-correlation.ts');
  expect(
    'exports analyzeEngineCorrelation',
    /export\s+function\s+analyzeEngineCorrelation/.test(src),
    'analyzeEngineCorrelation missing',
  );
  expect(
    'reads three depths (d12 / d18 / d25)',
    /d12: DepthMatches/.test(src) && /d18: DepthMatches/.test(src) && /d25: DepthMatches/.test(src),
    'three-depth shape missing',
  );
  expect(
    'insufficient evidence returns severity 0',
    /MIN_PLIES_FOR_VERDICT/.test(src) && /severity: 0/.test(src),
    'insufficient-evidence path drifted',
  );
  expect(
    'time-class cushion table covers all four classes',
    /bullet: 0\.08/.test(src) &&
      /blitz: 0\.05/.test(src) &&
      /rapid: 0\.02/.test(src) &&
      /classical: 0\.0/.test(src),
    'time-class cushion table drifted',
  );
  expect(
    'depth signature requires d12 AND d25 elevated',
    /d12Rate > baseline\.p99[\s\S]{0,80}d25Rate > baseline\.p99/.test(src),
    'depth signature logic drifted',
  );
}

console.log('\nmove-time.ts');
{
  const src = read('apps/web/lib/fairplay/move-time.ts');
  expect(
    'exports analyzeMoveTime',
    /export\s+function\s+analyzeMoveTime/.test(src),
    'analyzeMoveTime missing',
  );
  expect(
    'Pearson correlation helper present',
    /function\s+pearson/.test(src),
    'pearson helper missing',
  );
  expect(
    'uses log(timeMs) to dampen single thinks',
    /Math\.log\(Math\.max\(1,\s*r\.timeMs\)\)/.test(src),
    'log scaling missing',
  );
  expect(
    'signal taxonomy: too_few_moves / natural / flat / inverted',
    /'too_few_moves'/.test(src) &&
      /'natural'/.test(src) &&
      /'flat'/.test(src) &&
      /'inverted'/.test(src),
    'signal taxonomy drifted',
  );
}

console.log('\nsandbagging.ts');
{
  const src = read('apps/web/lib/fairplay/sandbagging.ts');
  expect(
    'exports analyzeSandbagging',
    /export\s+function\s+analyzeSandbagging/.test(src),
    'analyzeSandbagging missing',
  );
  expect(
    'external rating cap multiplier is 1.5 per spec §12',
    /EXTERNAL_CAP_MULTIPLIER\s*=\s*1\.5/.test(src),
    'external cap drifted',
  );
  expect(
    'rating velocity gate is account-age-limited',
    /accountAgeDays <= 30/.test(src),
    'velocity gate scope drifted',
  );
}

console.log('\naction-stack.ts');
{
  const src = read('apps/web/lib/fairplay/action-stack.ts');
  expect(
    'exports planForSeverity',
    /export\s+function\s+planForSeverity/.test(src),
    'planForSeverity missing',
  );
  expect(
    'severity 1 = warning, no side effects',
    /Warning.*logged.*no restriction[\s\S]{0,200}sideEffects: \[\]/.test(src),
    'severity 1 plan drifted',
  );
  expect(
    'severity 6 = permanent ban + forfeit',
    /'forfeit_pending_balance'/.test(src),
    'severity 6 forfeit missing',
  );
  expect(
    'side-effect taxonomy covers wallet + sessions + challenges',
    /'cancel_open_challenges'/.test(src) &&
      /'freeze_wallet'/.test(src) &&
      /'invalidate_sessions'/.test(src),
    'side-effect taxonomy drifted',
  );
}

console.log('\nroutes + UI');
{
  const queue = read('apps/web/app/admin/fairplay/page.tsx');
  const report = read('apps/web/app/api/fairplay/report/route.ts');
  const decide = read('apps/web/app/api/fairplay/[id]/decide/route.ts');
  const bans = read('apps/web/app/fairplay/bans/page.tsx');
  expect(
    'admin queue gated on isSuperAdminEmail',
    /isSuperAdminEmail/.test(queue),
    'admin queue auth gate missing',
  );
  expect(
    'admin queue orders by severity DESC then created_at ASC',
    /severity DESC, fp\.created_at ASC/.test(queue),
    'queue ordering drifted from spec §12 (highest severity first, then oldest)',
  );
  expect(
    'report endpoint rate-limited (5/day)',
    /DAILY_REPORT_CAP\s*=\s*5/.test(report),
    'report rate limit drifted',
  );
  expect(
    'report endpoint verifies participant in match',
    /not_a_participant/.test(report),
    'participant check missing',
  );
  expect(
    'decide endpoint enforces super-admin',
    /isSuperAdminEmail/.test(decide),
    'decide auth gate missing',
  );
  expect(
    'decide endpoint writes ban_actions on confirmed',
    /INSERT INTO ban_actions/.test(decide),
    'ban_actions write missing',
  );
  expect(
    'public ban list only shows severity ≥ 5 + opt-in profiles',
    /severity >= 5/.test(bans) && /profile_visibility = 'public'/.test(bans),
    'public ban list filters drifted',
  );
}

console.log('\ntransparency worker');
{
  const src = read('apps/workers/src/fairplay/transparency-report.ts');
  expect(
    'aggregates flags / outcomes / bans / appeals',
    /flagsByType/.test(src) &&
      /flagsByOutcome/.test(src) &&
      /bansBySeverity/.test(src) &&
      /appeals/.test(src),
    'transparency aggregation missing fields',
  );
  expect(
    'default year = prevYear so January cron publishes the past year',
    /getUTCFullYear\(\)\s*-\s*1/.test(src),
    'default-year drift',
  );
  expect(
    'output path includes the year',
    /fairplay-transparency-\$\{year\}\.json/.test(src),
    'output path drift',
  );
}

if (failures > 0) {
  console.error(`\n${failures} WS-11 audit(s) failed`);
  process.exit(1);
} else {
  console.log('\nall ws11-libs.test.ts audits passed');
}
