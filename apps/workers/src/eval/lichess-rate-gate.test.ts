/**
 * Sprint lever 3 — verify the lichess-api rate-gate mutex serialises
 * concurrent callers (no burst races).
 *
 *   pnpm --filter @chessco/workers exec tsx src/eval/lichess-rate-gate.test.ts
 *
 * Mocks global.fetch to avoid actually hitting Lichess. The fetch impl
 * records request timestamps; we then assert that the timestamps from N
 * concurrent fetchUserGamesPgn() calls are spaced >=MIN_REQUEST_GAP_MS
 * apart. With the old shared-variable impl, concurrent callers would all
 * fire within ~1ms of each other; with the chain-mutex they must serialise.
 */
import { Readable } from 'node:stream';

const MIN_GAP_MS_EXPECTED = 1500; // anonymous mode (no LICHESS_API_TOKEN)

const calls: number[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (): Promise<Response> => {
  calls.push(Date.now());
  // Return an empty 404 so fetchUserGamesPgn returns null fast.
  return new Response('', { status: 404 });
};

// Import AFTER patching globalThis.fetch so the module captures the mock.
const { fetchUserGamesPgn } = await import('../lib/lichess-api');

let failures = 0;
function expect(label: string, ok: boolean, detail: string): void {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label} — ${detail}`);
  }
}

console.log('lichess rate-gate mutex — 5 concurrent fetchUserGamesPgn()');
{
  // Fire 5 callers in parallel — the bug pattern. With the old impl they
  // all read the same lastRequestAt and fire within ~1ms.
  const t0 = Date.now();
  await Promise.all([
    fetchUserGamesPgn('alpha').catch(() => null),
    fetchUserGamesPgn('beta').catch(() => null),
    fetchUserGamesPgn('gamma').catch(() => null),
    fetchUserGamesPgn('delta').catch(() => null),
    fetchUserGamesPgn('epsilon').catch(() => null),
  ]);
  const elapsed = Date.now() - t0;
  expect(
    `recorded 5 fetch calls (got ${calls.length})`,
    calls.length === 5,
    `expected 5, got ${calls.length}`,
  );

  // After serialisation, consecutive call timestamps should be >=
  // MIN_GAP_MS_EXPECTED apart (allow 50ms timer slack). The first call
  // fires immediately; calls 2..N each wait their gap.
  let badPairs = 0;
  const gaps: number[] = [];
  for (let i = 1; i < calls.length; i++) {
    const gap = calls[i]! - calls[i - 1]!;
    gaps.push(gap);
    if (gap < MIN_GAP_MS_EXPECTED - 50) badPairs++;
  }
  expect(
    `consecutive gaps >= ${MIN_GAP_MS_EXPECTED}ms (gaps: ${gaps.join('ms, ')}ms)`,
    badPairs === 0,
    `${badPairs} pairs fired too close together`,
  );

  // 5 calls serialised at 1500ms each = ~6s total (first immediate, 4 gaps of 1500).
  expect(
    `total elapsed ≈ ${4 * MIN_GAP_MS_EXPECTED}ms (got ${elapsed}ms)`,
    elapsed >= 4 * MIN_GAP_MS_EXPECTED - 100 && elapsed <= 5 * MIN_GAP_MS_EXPECTED,
    `elapsed=${elapsed}ms outside expected band`,
  );
}

globalThis.fetch = originalFetch;
// Touch unused import so the file isn't flagged for it.
void Readable;

if (failures > 0) {
  console.log(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll lichess-rate-gate.test.ts assertions passed');
