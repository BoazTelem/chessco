/**
 * Ingest backbone health CLI.
 *
 * Single command that probes both Postgres backends (Supabase + Cloud SQL
 * games corpus) and prints a one-screen status of the Phase 1 ingest
 * surface. The operator uses this to answer "what's actually populated?"
 * without spelunking SQL clients.
 *
 *   pnpm --filter @chessco/workers ingest:status
 *   pnpm --filter @chessco/workers ingest:status --json
 *
 * The CLI never throws on a missing DB — it reports "unreachable" with the
 * error message and continues. That keeps the script useful when only one
 * of the two databases is configured (e.g. during early Cloud SQL bring-up).
 */
import 'dotenv/config';
import type postgres from 'postgres';

type Stale = { kind: 'fresh' | 'stale' | 'missing'; detail: string };

interface DbStatus {
  label: string;
  reachable: boolean;
  detail: string;
  rows: Array<{ name: string; count: number | null; stale: Stale | null }>;
  error?: string;
}

interface Snapshot {
  generatedAt: string;
  supabase: DbStatus;
  games: DbStatus;
}

const STALE_DAYS = {
  fide: 35, // FIDE refresh is monthly; >35d means a cycle was missed
  lichess_games: 45, // monthly dumps land mid-month
  chesscom_games: 14, // PubAPI cache TTL is 7d; >14d means refresh-stale stalled
  stockfish: 7, // analyzed-at backfill should keep up within a week
};

async function probeSupabase(): Promise<DbStatus> {
  const status: DbStatus = {
    label: 'Supabase (federation, profiles, identification)',
    reachable: false,
    detail: '',
    rows: [],
  };
  let client: postgres.Sql | null = null;
  try {
    const { getDb } = await import('./db');
    ({ client } = getDb());
    const probe = await client<{ now: string }[]>`SELECT NOW()::text AS now`;
    const now = probe[0]?.now ?? new Date().toISOString();
    status.reachable = true;
    status.detail = `connected; server time ${now}`;

    status.rows.push(await countOnly(client, 'federations'));
    status.rows.push(await countOnly(client, 'federation_players'));
    status.rows.push(await countOnly(client, 'players'));
    status.rows.push(await countOnly(client, 'profiles'));
    status.rows.push(await countOnly(client, 'identification_queries'));
    status.rows.push(
      await countWithFreshness(
        client,
        'federation_rating_snapshots',
        'captured_at',
        STALE_DAYS.fide,
        'fide',
      ),
    );
  } catch (err) {
    status.error = err instanceof Error ? err.message : String(err);
  } finally {
    if (client) await client.end({ timeout: 5 }).catch(() => undefined);
  }
  return status;
}

async function probeGames(): Promise<DbStatus> {
  const status: DbStatus = {
    label: 'Cloud SQL games corpus (Phase 1 backbone)',
    reachable: false,
    detail: '',
    rows: [],
  };
  let client: postgres.Sql | null = null;
  try {
    const { getGamesDb } = await import('./db');
    ({ client } = getGamesDb());
    const probe = await client<{ now: string }[]>`SELECT NOW()::text AS now`;
    const now = probe[0]?.now ?? new Date().toISOString();
    status.reachable = true;
    status.detail = `connected; server time ${now}`;

    status.rows.push(await countOnly(client, 'handles'));
    status.rows.push(await scoutReadyCount(client));
    status.rows.push(
      await countWithFreshness(client, 'games', 'played_at', STALE_DAYS.lichess_games, 'lichess'),
    );
    status.rows.push(
      await countWithFreshness(
        client,
        'games',
        'played_at',
        STALE_DAYS.chesscom_games,
        'chess.com',
      ),
    );
    status.rows.push(await countOnly(client, 'positions'));
    status.rows.push(await countOnly(client, 'moves'));
    status.rows.push(await stockfishCoverage(client));
    status.rows.push(await countOnly(client, 'account_fingerprints'));
    status.rows.push(await countOnly(client, 'fingerprint_terms'));
  } catch (err) {
    status.error = err instanceof Error ? err.message : String(err);
  } finally {
    if (client) await client.end({ timeout: 5 }).catch(() => undefined);
  }
  return status;
}

async function countOnly(
  client: postgres.Sql,
  table: string,
): Promise<{ name: string; count: number | null; stale: Stale | null }> {
  try {
    const rows = await client.unsafe<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count FROM ${table}`,
    );
    return { name: table, count: Number.parseInt(rows[0]!.count, 10), stale: null };
  } catch (err) {
    return {
      name: `${table} (error)`,
      count: null,
      stale: { kind: 'missing', detail: err instanceof Error ? err.message : String(err) },
    };
  }
}

async function countWithFreshness(
  client: postgres.Sql,
  table: string,
  tsColumn: string,
  staleDays: number,
  sourceFilter: string | null,
): Promise<{ name: string; count: number | null; stale: Stale | null }> {
  try {
    const filterClause = sourceFilter ? `WHERE source = '${sourceFilter}'` : '';
    const rows = await client.unsafe<{ count: string; latest: string | null }[]>(
      `SELECT COUNT(*)::text AS count, MAX(${tsColumn})::text AS latest FROM ${table} ${filterClause}`,
    );
    const count = Number.parseInt(rows[0]!.count, 10);
    const latest = rows[0]!.latest;
    const label = sourceFilter ? `${table} (${sourceFilter})` : table;
    if (latest === null) {
      return { name: label, count, stale: { kind: 'missing', detail: 'no rows' } };
    }
    const ageDays = (Date.now() - new Date(latest).getTime()) / (1000 * 60 * 60 * 24);
    const stale: Stale =
      ageDays > staleDays
        ? {
            kind: 'stale',
            detail: `latest ${latest.slice(0, 10)} (${ageDays.toFixed(0)}d ago, threshold ${staleDays}d)`,
          }
        : { kind: 'fresh', detail: `latest ${latest.slice(0, 10)} (${ageDays.toFixed(0)}d ago)` };
    return { name: label, count, stale };
  } catch (err) {
    return {
      name: `${table} (${sourceFilter ?? 'all'}) [error]`,
      count: null,
      stale: { kind: 'missing', detail: err instanceof Error ? err.message : String(err) },
    };
  }
}

async function scoutReadyCount(
  client: postgres.Sql,
): Promise<{ name: string; count: number | null; stale: Stale | null }> {
  try {
    const rows = await client<
      { count: string }[]
    >`SELECT COUNT(*)::text AS count FROM handles WHERE scout_ready_at IS NOT NULL`;
    return {
      name: 'handles (scout_ready)',
      count: Number.parseInt(rows[0]!.count, 10),
      stale: null,
    };
  } catch (err) {
    return {
      name: 'handles (scout_ready) [error]',
      count: null,
      stale: { kind: 'missing', detail: err instanceof Error ? err.message : String(err) },
    };
  }
}

async function stockfishCoverage(
  client: postgres.Sql,
): Promise<{ name: string; count: number | null; stale: Stale | null }> {
  try {
    const rows = await client<{ analyzed: string; total: string; latest: string | null }[]>`
      SELECT
        COUNT(*) FILTER (WHERE analyzed_at IS NOT NULL)::text AS analyzed,
        COUNT(*)::text AS total,
        MAX(analyzed_at)::text AS latest
      FROM games
    `;
    const r = rows[0]!;
    const analyzed = Number.parseInt(r.analyzed, 10);
    const total = Number.parseInt(r.total, 10);
    const pct = total === 0 ? 0 : (analyzed / total) * 100;
    const latest = r.latest;
    let stale: Stale | null = null;
    if (latest === null) {
      stale = { kind: 'missing', detail: 'no analyzed games' };
    } else {
      const ageDays = (Date.now() - new Date(latest).getTime()) / (1000 * 60 * 60 * 24);
      stale =
        ageDays > STALE_DAYS.stockfish
          ? {
              kind: 'stale',
              detail: `last analysis ${latest.slice(0, 10)} (${ageDays.toFixed(0)}d ago)`,
            }
          : {
              kind: 'fresh',
              detail: `last analysis ${latest.slice(0, 10)}; ${pct.toFixed(1)}% coverage`,
            };
    }
    return { name: 'games.analyzed_at (stockfish)', count: analyzed, stale };
  } catch (err) {
    return {
      name: 'games.analyzed_at (stockfish) [error]',
      count: null,
      stale: { kind: 'missing', detail: err instanceof Error ? err.message : String(err) },
    };
  }
}

function fmtCount(n: number | null): string {
  if (n === null) return '   error';
  return n.toLocaleString().padStart(12);
}

function fmtStale(stale: Stale | null): string {
  if (!stale) return '';
  const icon = stale.kind === 'fresh' ? '✓' : stale.kind === 'stale' ? '⚠' : '✗';
  return ` ${icon} ${stale.detail}`;
}

function printDb(status: DbStatus): void {
  console.log('');
  console.log(`# ${status.label}`);
  if (!status.reachable) {
    console.log(`  ✗ unreachable: ${status.error ?? 'unknown error'}`);
    return;
  }
  console.log(`  ✓ ${status.detail}`);
  for (const row of status.rows) {
    console.log(`    ${fmtCount(row.count)}  ${row.name.padEnd(36)}${fmtStale(row.stale)}`);
  }
}

async function main(): Promise<void> {
  const wantJson = process.argv.includes('--json');
  const [supabase, games] = await Promise.all([probeSupabase(), probeGames()]);
  const snapshot: Snapshot = {
    generatedAt: new Date().toISOString(),
    supabase,
    games,
  };
  if (wantJson) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  console.log(`# Chessco ingest status — ${snapshot.generatedAt}`);
  printDb(supabase);
  printDb(games);

  const anyUnreachable = !supabase.reachable || !games.reachable;
  const anyStale = [supabase, games].some((s) =>
    s.rows.some((r) => r.stale?.kind === 'stale' || r.stale?.kind === 'missing'),
  );
  if (anyUnreachable) process.exit(2);
  if (anyStale) process.exit(1);
}

void main();
