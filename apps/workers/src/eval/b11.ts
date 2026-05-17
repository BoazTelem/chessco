/**
 * B11 — AI prompt regression.
 *
 * Reads golden fixtures from apps/workers/src/eval/fixtures/ai-prompts/*.json
 * and compares each prompt's current output (loaded from the prompt library
 * in packages/ai) against its locked golden output. A fixture passes when
 * its current output's shape and key invariants match the golden.
 *
 * `packages/ai` is still a stub today, so by default this benchmark emits a
 * "pending" verdict explaining what's blocked. Once WS-3 lands the prompt
 * library, this script gets a real comparator without changing its CLI.
 *
 *   pnpm --filter @chessco/workers bench:b11
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Verdict } from './_lib/spec';
import { errorVerdict, logVerdict, pendingVerdict, rollup, writeVerdict } from './_lib/verdict';

interface PromptFixture {
  prompt_id: string;
  model_version: string;
  golden_output: unknown;
  /**
   * Lightweight shape checks the comparator looks for in the live output.
   * Each entry is a JSON-path-ish dotted key plus an expected primitive
   * value or `"<defined>"` meaning the path must exist.
   */
  shape_invariants: Array<{ path: string; expect: string | number | boolean | '<defined>' }>;
}

const FIXTURES_DIR = pathResolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/ai-prompts');

function loadFixtures(): PromptFixture[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(FIXTURES_DIR, f), 'utf8')) as PromptFixture);
}

async function loadPromptLibrary(): Promise<
  { kind: 'stub'; version: string } | { kind: 'ready'; inspectPrompt: (id: string) => unknown }
> {
  // The prompt library at packages/ai exposes inspectPrompt(id) which
  // returns metadata about a prompt definition (model, version, system
  // blocks, params). That's enough for a shape-regression benchmark
  // without spending API tokens. A future variant of B11 can add a
  // recorded-output regression that calls runPrompt() against snapshots.
  try {
    const mod = (await import('@chessco/ai')) as unknown as {
      promptLibraryVersion?: string;
      inspectPrompt?: (id: string) => unknown;
    };
    if (typeof mod.inspectPrompt === 'function') {
      return { kind: 'ready', inspectPrompt: mod.inspectPrompt };
    }
    return { kind: 'stub', version: mod.promptLibraryVersion ?? 'unknown' };
  } catch (err) {
    throw new Error(
      `failed to import @chessco/ai: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    if (typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

function invariantPasses(
  output: unknown,
  invariant: PromptFixture['shape_invariants'][number],
): { ok: boolean; actual: string } {
  const value = getPath(output, invariant.path);
  if (invariant.expect === '<defined>') {
    return { ok: value !== undefined, actual: value === undefined ? 'missing' : 'present' };
  }
  return {
    ok: value === invariant.expect,
    actual: value === undefined ? 'missing' : String(value),
  };
}

async function main(): Promise<void> {
  let verdict: Verdict;
  try {
    const fixtures = loadFixtures();
    const library = await loadPromptLibrary();

    if (fixtures.length === 0) {
      verdict = pendingVerdict(
        'b11',
        'AI prompt regression',
        'No fixtures present at apps/workers/src/eval/fixtures/ai-prompts/. ' +
          'Add golden fixtures when the prompt library lands (WS-3).',
      );
    } else if (library.kind === 'stub') {
      verdict = pendingVerdict(
        'b11',
        'AI prompt regression',
        `Prompt library at @chessco/ai is still a stub (v${library.version}). ` +
          `${fixtures.length} fixture(s) loaded but cannot be exercised yet.`,
      );
    } else {
      const criteria = [];
      let allPassed = true;
      for (const fx of fixtures) {
        try {
          const output = library.inspectPrompt(fx.prompt_id);
          const checks = fx.shape_invariants.map((inv) => invariantPasses(output, inv));
          const fixtureOk = checks.every((c) => c.ok);
          if (!fixtureOk) allPassed = false;
          for (let i = 0; i < fx.shape_invariants.length; i++) {
            const inv = fx.shape_invariants[i]!;
            const check = checks[i]!;
            criteria.push({
              label: `${fx.prompt_id} • ${inv.path}`,
              threshold: invariantThreshold(inv),
              actual: check.actual,
              passed: check.ok,
            });
          }
        } catch (err) {
          allPassed = false;
          criteria.push({
            label: `${fx.prompt_id} • inspectPrompt`,
            threshold: 'no error',
            actual: err instanceof Error ? err.message : String(err),
            passed: false,
          });
        }
      }

      verdict = {
        id: 'b11',
        title: 'AI prompt regression',
        status: rollup([allPassed]),
        headline: `${fixtures.length} fixture(s) checked across ${new Set(fixtures.map((f) => f.prompt_id)).size} prompt(s)`,
        criteria,
        generatedAt: new Date().toISOString(),
      };
    }
  } catch (err) {
    verdict = errorVerdict('b11', 'AI prompt regression', err);
  }

  const written = writeVerdict(verdict);
  logVerdict(verdict);
  console.log(`[b11] verdict written to ${written}`);
  if (verdict.status === 'fail') process.exit(1);
}

function invariantThreshold(inv: PromptFixture['shape_invariants'][number]): string {
  return inv.expect === '<defined>' ? 'present' : `= ${String(inv.expect)}`;
}

void main();
