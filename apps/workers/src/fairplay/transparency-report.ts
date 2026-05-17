/**
 * Annual fairplay transparency report aggregator. Spec §12.
 *
 *   pnpm --filter @chessco/workers fairplay:transparency
 *   pnpm --filter @chessco/workers fairplay:transparency -- --year 2026
 *
 * Aggregates fairplay_flags + ban_actions for the requested calendar
 * year and emits a JSON payload at
 * apps/web/public/fairplay-transparency-{year}.json.
 *
 * The /fairplay/bans page references the report; an annual cron runs
 * this on January 2nd UTC to publish the previous year.
 *
 * Fields published (no PII):
 *   - total_flags
 *   - flags_by_type
 *   - flags_by_outcome (confirmed / dismissed / pending)
 *   - ban_actions_by_severity
 *   - false_positive_rate_estimate (confirmed_after_appeal_reversal / confirmed)
 *   - appeals_summary
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';

const REPO_ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

interface FlagAggregate {
  flag_type: string;
  count: string;
}
interface OutcomeAggregate {
  outcome: string;
  count: string;
}
interface SeverityAggregate {
  severity: number;
  count: string;
}
interface AppealAggregate {
  total: string;
  reversed: string;
}

function getYear(argv: string[]): number {
  const idx = argv.indexOf('--year');
  if (idx !== -1 && argv[idx + 1]) {
    const y = Number.parseInt(argv[idx + 1]!, 10);
    if (Number.isFinite(y) && y > 2020 && y < 2100) return y;
  }
  const now = new Date();
  // Default to previous year so the cron firing in early January
  // publishes the year that just ended.
  return now.getUTCFullYear() - 1;
}

async function main(): Promise<void> {
  const year = getYear(process.argv.slice(2));
  const start = `${year}-01-01T00:00:00Z`;
  const end = `${year + 1}-01-01T00:00:00Z`;

  let client: postgres.Sql;
  try {
    const { getDb } = await import('../db');
    ({ client } = getDb());
  } catch (err) {
    console.error(
      '[fairplay:transparency] DB unreachable:',
      err instanceof Error ? err.message : err,
    );
    process.exit(3);
  }

  try {
    const flagsByType = await client<FlagAggregate[]>`
      SELECT flag_type, COUNT(*)::text AS count
      FROM fairplay_flags
      WHERE created_at >= ${start}::timestamptz AND created_at < ${end}::timestamptz
      GROUP BY flag_type ORDER BY flag_type
    `;
    const flagsByOutcome = await client<OutcomeAggregate[]>`
      SELECT outcome, COUNT(*)::text AS count
      FROM fairplay_flags
      WHERE created_at >= ${start}::timestamptz AND created_at < ${end}::timestamptz
      GROUP BY outcome ORDER BY outcome
    `;
    const bansBySeverity = await client<SeverityAggregate[]>`
      SELECT severity, COUNT(*)::text AS count
      FROM ban_actions
      WHERE created_at >= ${start}::timestamptz AND created_at < ${end}::timestamptz
      GROUP BY severity ORDER BY severity
    `;
    const appeals = await client<AppealAggregate[]>`
      SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE reversed_at IS NOT NULL)::text AS reversed
      FROM ban_actions
      WHERE created_at >= ${start}::timestamptz AND created_at < ${end}::timestamptz
    `;
    const appealsRow = appeals[0] ?? { total: '0', reversed: '0' };
    const totalBans = Number(appealsRow.total);
    const reversedBans = Number(appealsRow.reversed);
    const fpRate = totalBans > 0 ? reversedBans / totalBans : 0;

    const report = {
      year,
      generated_at: new Date().toISOString(),
      flags: {
        total: flagsByType.reduce((acc, r) => acc + Number(r.count), 0),
        by_type: flagsByType.map((r) => ({ flag_type: r.flag_type, count: Number(r.count) })),
        by_outcome: flagsByOutcome.map((r) => ({ outcome: r.outcome, count: Number(r.count) })),
      },
      ban_actions: {
        total: totalBans,
        by_severity: bansBySeverity.map((r) => ({ severity: r.severity, count: Number(r.count) })),
      },
      appeals: {
        total_bans: totalBans,
        reversed: reversedBans,
        estimated_false_positive_rate: Number(fpRate.toFixed(4)),
      },
    };

    const outPath = pathResolve(REPO_ROOT, `apps/web/public/fairplay-transparency-${year}.json`);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`[fairplay:transparency] wrote ${outPath}`);
    console.log(
      `  flags=${report.flags.total} bans=${report.ban_actions.total} ` +
        `reversed=${reversedBans} fp_rate=${(fpRate * 100).toFixed(2)}%`,
    );
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
}

void main();
