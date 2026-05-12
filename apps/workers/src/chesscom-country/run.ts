/**
 * Pre-pull chess.com country-restricted handle lists into Supabase
 * platform_players. One entry per (platform='chess.com', handle) row;
 * country gets set from the ISO code we fetched, no per-handle profile
 * lookup needed.
 *
 * Usage:
 *   pnpm --filter @chessco/workers chesscom:country IL US GB CA AU
 *   pnpm --filter @chessco/workers chesscom:country --launch     # IL+EU+UK+CA+AU
 *
 * Country lists can be 100k-1M handles each. Insertion is chunked.
 */
import 'dotenv/config';
import type postgres from 'postgres';
import { getDb } from '../db';
import { fetchCountryPlayers } from '../lib/chesscom-api';

/** Phase 1 launch markets from PLAN.md. EU collapsed to a few big ISOs. */
const LAUNCH_MARKETS = [
  'IL',
  'GB',
  'CA',
  'AU',
  // EU big-five — Germany, France, Italy, Spain, Netherlands.
  'DE',
  'FR',
  'IT',
  'ES',
  'NL',
];

const ROW_CHUNK = 5000; // ON CONFLICT INSERT chunk size (well under 65k param cap)

interface Args {
  isos: string[];
}

function parseArgs(argv: string[]): Args {
  const isos: string[] = [];
  for (const a of argv) {
    if (a === '--launch') {
      isos.push(...LAUNCH_MARKETS);
    } else if (/^[A-Z]{2,3}$/i.test(a)) {
      isos.push(a.toUpperCase());
    } else {
      throw new Error(`Bad arg: ${a}. Expected ISO codes (IL, US, GB, ...) or --launch.`);
    }
  }
  if (isos.length === 0) {
    throw new Error('No ISO codes provided. Usage: chesscom:country IL US ... | --launch');
  }
  return { isos };
}

async function upsertCountryChunk(
  sql: postgres.Sql,
  iso: string,
  handles: string[],
): Promise<number> {
  const insert = sql as unknown as (rows: object[], ...cols: string[]) => postgres.Helper<object[]>;
  const rows = handles.map((h) => {
    const normalized = h.trim().toLowerCase();
    return {
      platform: 'chess.com',
      handle: normalized,
      handle_normalized: normalized,
      country: iso,
      pulled_via: 'country',
    };
  });
  const result = await sql<{ id: string }[]>`
    INSERT INTO platform_players
      ${insert(rows, 'platform', 'handle', 'handle_normalized', 'country', 'pulled_via')}
    ON CONFLICT (platform, handle) DO UPDATE SET
      country = COALESCE(EXCLUDED.country, platform_players.country),
      last_seen_at = NOW()
    RETURNING id
  `;
  return result.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[chesscom-country] isos=[${args.isos.join(',')}]`);

  const { client } = getDb();
  try {
    const startedAt = Date.now();
    let totalFetched = 0;
    let totalUpserted = 0;

    for (const iso of args.isos) {
      const runs = await client<{ id: string }[]>`
        INSERT INTO platform_pull_runs (worker, target)
        VALUES ('chesscom-country', ${iso})
        RETURNING id
      `;
      const runId = runs[0]?.id;
      if (!runId) throw new Error('failed to create platform_pull_runs row');

      try {
        console.log(`\n→ /pub/country/${iso}/players`);
        const t0 = Date.now();
        const handles = await fetchCountryPlayers(iso);
        console.log(
          `  fetched ${handles.length.toLocaleString()} handles (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
        );

        let upserted = 0;
        for (let i = 0; i < handles.length; i += ROW_CHUNK) {
          const chunk = handles.slice(i, i + ROW_CHUNK);
          upserted += await upsertCountryChunk(client, iso, chunk);
        }
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`  upserted=${upserted.toLocaleString()} (${dt}s)`);

        totalFetched += handles.length;
        totalUpserted += upserted;

        await client`
          UPDATE platform_pull_runs SET
            status = 'done',
            fetched = ${handles.length},
            upserted = ${upserted},
            completed_at = NOW()
          WHERE id = ${runId}
        `;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ✗ ${iso} failed: ${msg}`);
        await client`
          UPDATE platform_pull_runs SET
            status = 'failed', completed_at = NOW(), error = ${msg}
          WHERE id = ${runId}
        `;
      }
    }

    const totalDt = ((Date.now() - startedAt) / 1000).toFixed(0);
    console.log(
      `\n[chesscom-country] DONE total_fetched=${totalFetched.toLocaleString()} ` +
        `total_upserted=${totalUpserted.toLocaleString()} (${totalDt}s)`,
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('chesscom-country failed:', err);
  process.exit(1);
});
