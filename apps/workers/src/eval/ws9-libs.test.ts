/**
 * WS-9 surface audit — six libraries in one pass.
 *
 *   pnpm --filter @chessco/workers exec tsx src/eval/ws9-libs.test.ts
 *
 * Static checks (no runtime) because the libs live in apps/web and
 * cross-package runtime imports break on ESM/CJS interop (apps/web is
 * not type:module). Typecheck enforces the public type signatures; this
 * test locks the surface so a refactor can't quietly drop a feature.
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

console.log('glicko2.ts');
{
  const src = read('apps/web/lib/glicko2.ts');
  expect(
    'exports updateSingle / updateBatched / updatePair / NEW_PLAYER',
    /export\s+function\s+updateSingle/.test(src) &&
      /export\s+function\s+updateBatched/.test(src) &&
      /export\s+function\s+updatePair/.test(src) &&
      /export\s+const\s+NEW_PLAYER/.test(src),
    'missing one of the public exports',
  );
  expect(
    'system constant τ is set',
    /SYSTEM_TAU\s*=\s*0\.5/.test(src),
    'τ drifted from Glickman 2012 default',
  );
  expect(
    'scale + base constants',
    /GLICKO_SCALE\s*=\s*173\.7178/.test(src) && /GLICKO_BASE\s*=\s*1500/.test(src),
    'Glicko-2 constants drifted',
  );
  expect(
    'handles "did not compete" branch',
    /games\.length === 0/.test(src),
    'no-games branch missing',
  );
}

console.log('\ntrust-score.ts');
{
  const src = read('apps/web/lib/trust-score.ts');
  expect(
    'exports computeTrustScore / tierFromScore / tierGates',
    /export\s+function\s+computeTrustScore/.test(src) &&
      /export\s+function\s+tierFromScore/.test(src) &&
      /export\s+function\s+tierGates/.test(src),
    'missing one of the public exports',
  );
  expect(
    'tier ladder: platinum/gold/silver/bronze/new',
    /platinum.*minScore: 90/.test(src) &&
      /gold.*minScore: 75/.test(src) &&
      /silver.*minScore: 55/.test(src) &&
      /bronze.*minScore: 35/.test(src),
    'tier thresholds drifted',
  );
  expect(
    'fairplay penalty capped at 50 points',
    /Math\.min[^)]*50/.test(src) || /clamp\([^)]*fairplayFlagsConfirmed[^)]*50\)/.test(src),
    'fairplay cap drifted',
  );
  expect(
    'new tier blocks paid challenge creation',
    /'new':[\s\S]{0,160}canCreatePaidChallenges:\s*false/.test(src),
    'new-tier paid challenge gate drifted',
  );
}

console.log('\nrefund-auto.ts');
{
  const src = read('apps/web/lib/refund-auto.ts');
  expect(
    'exports resolveRefundAutomatically',
    /export\s+function\s+resolveRefundAutomatically/.test(src),
    'export missing',
  );
  expect(
    'opp_disconnect_confirmed only when status=abandoned + abandonedBy=opponent',
    /matchStatus === 'abandoned'[\s\S]{0,80}abandonedBy === 'opponent'/.test(src),
    'opp_abandoned auto-rule logic drifted',
  );
  expect(
    'fen_mismatch_detected normalized to 4 fields',
    /\.split\(' '\)\.slice\(0,\s*4\)/.test(src),
    'FEN normalization missing — halfmove counters could cause false mismatches',
  );
  expect(
    'technical_failure / engine / harassment / other escalate',
    /'technical_failure':[\s\S]{0,200}under_review/.test(src),
    'escalation paths drifted',
  );
}

console.log('\nemail/index.ts + email/templates.ts');
{
  const idx = read('apps/web/lib/email/index.ts');
  const tpl = read('apps/web/lib/email/templates.ts');
  expect(
    'sendEmail returns SendResult shape',
    /export\s+async\s+function\s+sendEmail/.test(idx) && /SendResult/.test(idx),
    'sendEmail surface drifted',
  );
  expect(
    'returns transport_unconfigured when no key set',
    /transport_unconfigured/.test(idx),
    'unconfigured fallback missing',
  );
  expect(
    'seven template ids declared',
    /'verify_email'/.test(tpl) &&
      /'magic_link'/.test(tpl) &&
      /'prep_report_ready'/.test(tpl) &&
      /'challenge_accepted'/.test(tpl) &&
      /'match_settled'/.test(tpl) &&
      /'refund_decided'/.test(tpl) &&
      /'fairplay_action'/.test(tpl),
    'template id set drifted',
  );
  expect(
    'HTML rendered with escapeHtml',
    /function escapeHtml/.test(tpl),
    'HTML escaping helper missing — XSS risk',
  );
}

console.log('\nanalytics/events.ts');
{
  const src = read('apps/web/lib/analytics/events.ts');
  expect(
    'captureEvent + initSentry exports',
    /export\s+function\s+captureEvent/.test(src) &&
      /export\s+async\s+function\s+initSentry/.test(src),
    'analytics exports drifted',
  );
  expect(
    'event union includes the 10 declared events',
    /signup_completed/.test(src) &&
      /external_account_linked/.test(src) &&
      /prep_report_started/.test(src) &&
      /prep_report_viewed/.test(src) &&
      /challenge_published/.test(src) &&
      /challenge_accepted/.test(src) &&
      /match_completed/.test(src) &&
      /refund_filed/.test(src) &&
      /withdrawal_initiated/.test(src) &&
      /subscription_started/.test(src),
    'one of the 10 declared events is missing',
  );
  expect(
    'posthog transport gated on POSTHOG_API_KEY',
    /POSTHOG_API_KEY/.test(src),
    'env gate missing',
  );
}

console.log('\nGDPR routes');
{
  const exp = read('apps/web/app/api/account/export/route.ts');
  const del = read('apps/web/app/api/account/delete/route.ts');
  expect(
    'export rate-limited to once per 24h',
    /RATE_LIMIT_HOURS\s*=\s*24/.test(exp),
    'export rate limit drifted',
  );
  expect(
    'export audit-logs account.export',
    /'account\.export'/.test(exp),
    'export audit row missing',
  );
  expect(
    "delete requires confirm: 'DELETE'",
    /z\.literal\('DELETE'\)/.test(del),
    'delete confirm guard missing',
  );
  expect(
    'delete sets deleted_at + audit-logs account.delete',
    /deleted_at = NOW\(\)/.test(del) && /'account\.delete'/.test(del),
    'delete soft-delete + audit drifted',
  );
}

console.log('\nratings_by_time_class schema');
{
  const schema = read('packages/db/src/schema.ts');
  expect(
    'table declared with composite primary key on (profile_id, time_class)',
    /pgTable\(\s*['"]ratings_by_time_class['"][\s\S]{0,2000}primaryKey\(\s*{\s*columns:\s*\[\s*t\.profileId,\s*t\.timeClass\s*\]\s*}\s*\)/.test(
      schema,
    ),
    'ratings_by_time_class PK shape drifted',
  );
  expect(
    'time_class enum: bullet|blitz|rapid|classical',
    /'bullet'\s*\|\s*'blitz'\s*\|\s*'rapid'\s*\|\s*'classical'/.test(schema),
    'time_class enum drifted',
  );
}

if (failures > 0) {
  console.error(`\n${failures} WS-9 audit(s) failed`);
  process.exit(1);
} else {
  console.log('\nall ws9-libs.test.ts audits passed');
}
