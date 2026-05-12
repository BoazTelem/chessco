/**
 * Pre-pull chess.com titled handles for all 10 title codes into Supabase
 * platform_players. Phase 1 W2 worker.
 *
 * Usage:
 *   pnpm --filter @chessco/workers chesscom:titled                  # all titles
 *   pnpm --filter @chessco/workers chesscom:titled GM IM            # subset
 *   pnpm --filter @chessco/workers chesscom:titled --enrich         # +country/ratings
 *   pnpm --filter @chessco/workers chesscom:titled GM --no-enrich   # handles only
 */
import 'dotenv/config';
import { getDb } from '../db';
import { ALL_TITLES, fetchTitledList } from '../lib/chesscom-api';
import type { ChesscomTitle } from '../lib/chesscom-api';
import { upsertChesscomTitled } from './upsert';

interface Args {
  titles: ChesscomTitle[];
  enrich: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { titles: [], enrich: true };
  for (const a of argv) {
    if (a === '--enrich') out.enrich = true;
    else if (a === '--no-enrich') out.enrich = false;
    else if (ALL_TITLES.includes(a as ChesscomTitle)) {
      out.titles.push(a as ChesscomTitle);
    } else {
      throw new Error(`Unknown arg: ${a}. Valid titles: ${ALL_TITLES.join(', ')}`);
    }
  }
  if (out.titles.length === 0) out.titles = [...ALL_TITLES];
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[chesscom-titled] titles=[${args.titles.join(',')}] enrich=${args.enrich}`,
  );

  const { client } = getDb();
  try {
    const overallStart = Date.now();
    let totalUpserted = 0;
    let totalEnriched = 0;

    for (const title of args.titles) {
      const runs = await client<{ id: string }[]>`
        INSERT INTO platform_pull_runs (worker, target)
        VALUES ('chesscom-titled', ${title})
        RETURNING id
      `;
      const runId = runs[0]?.id;
      if (!runId) throw new Error('failed to create platform_pull_runs row');

      try {
        console.log(`\n→ /pub/titled/${title}`);
        const handles = await fetchTitledList(title);
        console.log(`  fetched ${handles.length} handles`);

        const t0 = Date.now();
        const r = await upsertChesscomTitled(client, title, handles, {
          enrich: args.enrich,
        });
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(
          `  upserted=${r.upserted} enriched=${r.enriched} errors=${r.errors} (${dt}s)`,
        );

        totalUpserted += r.upserted;
        totalEnriched += r.enriched;

        await client`
          UPDATE platform_pull_runs SET
            status = 'done',
            fetched = ${handles.length},
            upserted = ${r.upserted},
            completed_at = NOW()
          WHERE id = ${runId}
        `;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ✗ ${title} failed: ${msg}`);
        await client`
          UPDATE platform_pull_runs SET
            status = 'failed', completed_at = NOW(), error = ${msg}
          WHERE id = ${runId}
        `;
      }
    }

    const totalDt = ((Date.now() - overallStart) / 1000).toFixed(0);
    console.log(
      `\n[chesscom-titled] DONE total_upserted=${totalUpserted} total_enriched=${totalEnriched} (${totalDt}s)`,
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('chesscom-titled failed:', err);
  process.exit(1);
});
