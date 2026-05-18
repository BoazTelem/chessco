/**
 * publishBenchmarkArtifact: append a benchmark JSON payload to the
 * `benchmark_artifacts` table on Supabase. The /benchmarks page reads the
 * latest row per kind via the anon client (apps/web/lib/benchmarks.ts).
 *
 * Opens its own short-lived Supabase connection so cascade-bench (which
 * holds a Cloud SQL games-db connection) can call it without juggling
 * client pools. Coverage-bench already holds a Supabase client but the
 * extra connection is cheap and keeps the call site identical.
 */
import { getDb } from '../db';

export type BenchmarkKind = 'coverage_stats' | 'sparse_cascade' | 'legacy_repertoire';

export async function publishBenchmarkArtifact(kind: BenchmarkKind, data: unknown): Promise<void> {
  const { client: sql } = getDb();
  try {
    await sql`
      INSERT INTO benchmark_artifacts (kind, data)
      VALUES (${kind}, ${JSON.stringify(data)}::jsonb)
    `;
    console.log(`[publish] benchmark_artifacts <- ${kind}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
