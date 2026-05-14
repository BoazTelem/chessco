/**
 * Generates the VALUES tuples for migration 0032_seed_full_federation_directory.sql
 * from the TS-side source of truth at
 * apps/workers/src/lib/federations/directory.ts.
 *
 * Usage:
 *   pnpm --filter @chessco/db tsx scripts/gen-federations-seed.ts > /tmp/values.sql
 *
 * Then paste the output into the migration's INSERT statement. We deliberately
 * keep this manual (paste rather than auto-inject) so the migration stays a
 * self-contained, reviewable SQL file with all rows visible in `git diff`.
 *
 * Run it again whenever the directory const changes (URLs corrected, new
 * federations added, etc.) and ship a follow-up migration to apply the diff.
 */
import { FEDERATION_DIRECTORY } from '../../../apps/workers/src/lib/federations/directory.js';

function sqlString(value: string | null | undefined): string {
  if (value == null) return 'NULL';
  // SQL escape: double single-quotes, no e-strings.
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlBool(value: boolean | null | undefined): string {
  if (value == null) return 'NULL';
  return value ? 'true' : 'false';
}

function sqlInt(value: number | null | undefined): string {
  if (value == null) return 'NULL';
  return String(value);
}

const tuples: string[] = [];
for (const f of FEDERATION_DIRECTORY) {
  // Use iso2 as the legacy `country` column (preserves alpha-2 convention of
  // the pre-existing seed rows). Microstate sub-countries (ENG/SCO/WLS/IOM)
  // get country='GB' so existing FK constraints stay happy.
  const country = f.iso2 ?? null;
  tuples.push(
    `  (${[
      sqlString(f.code),
      sqlString(f.name),
      sqlString(country),
      sqlString(f.iso2),
      sqlString(f.iso3),
      sqlString(f.continent),
      sqlString(f.ratingListUrl),
      sqlString(f.ratingListFormat),
      sqlString(f.scrapeStrategy),
      sqlString(f.syncCadence),
      sqlInt(f.estPlayerCount),
      sqlString(f.notes ?? null),
      sqlBool(f.active),
    ].join(', ')})`,
  );
}

process.stdout.write(tuples.join(',\n') + '\n');
process.stdout.write(`-- ${FEDERATION_DIRECTORY.length} federation rows\n`);
