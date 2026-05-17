/**
 * Static audit of the PGN exporter.
 *
 * Cross-package runtime import of pgn-export.ts won't work (apps/web is
 * not type:module), so this test exercises the exporter via fs read +
 * regex/contract checks. Drift in the serializer shape flips a check.
 *
 *   pnpm --filter @chessco/workers exec tsx src/eval/pgn-export.test.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const PGN_PATH = pathResolve(REPO_ROOT, 'apps/web/lib/leaks/pgn-export.ts');

let failures = 0;
function expect(label: string, ok: boolean, detail: string): void {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label} — ${detail}`);
  }
}

const src = readFileSync(PGN_PATH, 'utf8');

console.log('pgn-export public surface');
expect(
  'exports exportReportAsPgn',
  /export\s+function\s+exportReportAsPgn\b/.test(src),
  'no exportReportAsPgn export found',
);
expect(
  'tag value escaping strips PGN-reserved chars',
  /SAFE_TAG\s*=\s*\/\[/.test(src) &&
    /SAFE_TAG\.replace\(/.test(src) === false &&
    /value\.replace\(SAFE_TAG,/.test(src),
  'PGN tag escape removed — chess clients reject malformed tags',
);
expect(
  'emits ChesscoReportId tag',
  /tag\('ChesscoReportId'/.test(src),
  'ChesscoReportId tag missing — share-link traceability breaks',
);
expect(
  'emits ChesscoLeakFingerprint tag',
  /tag\('ChesscoLeakFingerprint'/.test(src),
  'ChesscoLeakFingerprint tag missing',
);
expect(
  'emits ChesscoLeakKind tag (personalized / surprise / own discriminator)',
  /tag\('ChesscoLeakKind'/.test(src),
  'ChesscoLeakKind tag missing',
);
expect(
  'mid-game result token is "*"',
  /tag\('Result',\s*'\*'\)/.test(src),
  'Result tag value changed — should be "*" for non-finished positions',
);

if (failures > 0) {
  console.error(`\n${failures} pgn-export audit(s) failed`);
  process.exit(1);
} else {
  console.log('\nall pgn-export.test.ts audits passed');
}
