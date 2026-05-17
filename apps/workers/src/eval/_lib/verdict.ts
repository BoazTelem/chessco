/**
 * Verdict helpers shared by every B-script in apps/workers/src/eval/.
 *
 * - readArtifact() loads a JSON benchmark artifact and returns null if it
 *   isn't there yet. Callers turn that into a "pending" verdict instead of
 *   crashing — the dashboard surfaces the missing-artifact case clearly.
 * - writeVerdict() persists the verdict to apps/web/public/benchmarks/.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchmarkId, Verdict } from './spec';
import { verdictArtifactPath } from './spec';

/** apps/workers/src/eval/_lib/ → repo root is 5 levels up. */
const REPO_ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

export function repoPath(rel: string): string {
  return pathResolve(REPO_ROOT, rel);
}

export function readArtifact<T>(rel: string): { data: T; runAt: string | null } | null {
  const abs = repoPath(rel);
  if (!existsSync(abs)) return null;
  try {
    const raw = readFileSync(abs, 'utf8');
    const data = JSON.parse(raw) as T & {
      ts?: string;
      run_at?: string;
      generated_at?: string;
      finished_at?: string;
    };
    const runAt = data.finished_at ?? data.run_at ?? data.ts ?? data.generated_at ?? null;
    return { data: data as T, runAt };
  } catch (err) {
    throw new Error(
      `failed to parse benchmark artifact ${abs}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function writeVerdict(verdict: Verdict): string {
  const abs = repoPath(verdictArtifactPath(verdict.id));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(verdict, null, 2));
  return abs;
}

export function pendingVerdict(id: BenchmarkId, title: string, reason: string): Verdict {
  return {
    id,
    title,
    status: 'pending',
    headline: reason,
    criteria: [],
    generatedAt: new Date().toISOString(),
  };
}

export function errorVerdict(id: BenchmarkId, title: string, err: unknown): Verdict {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    id,
    title,
    status: 'error',
    headline: 'Benchmark failed to evaluate',
    criteria: [],
    generatedAt: new Date().toISOString(),
    error: msg,
  };
}

export function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'n/a';
  return `${(v * 100).toFixed(1)}%`;
}

export function fmtMs(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'n/a';
  if (v < 1000) return `${v.toFixed(0)} ms`;
  return `${(v / 1000).toFixed(1)} s`;
}

/** Aggregate verdict status from a list of per-criterion booleans. */
export function rollup(criteriaPassed: boolean[]): 'pass' | 'fail' {
  return criteriaPassed.every(Boolean) ? 'pass' : 'fail';
}

export function logVerdict(verdict: Verdict): void {
  const icon =
    verdict.status === 'pass'
      ? '✅'
      : verdict.status === 'fail'
        ? '❌'
        : verdict.status === 'pending'
          ? '⏳'
          : '⚠️';
  console.log(`${icon} [${verdict.id}] ${verdict.title}: ${verdict.headline}`);
  for (const c of verdict.criteria) {
    const ci = c.passed ? '  ✓' : '  ✗';
    console.log(`${ci} ${c.label}: ${c.actual} (target ${c.threshold})`);
  }
  if (verdict.error) console.log(`  error: ${verdict.error}`);
}
