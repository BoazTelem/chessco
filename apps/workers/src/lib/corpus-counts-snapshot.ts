/**
 * Snapshot games-corpus counts into Supabase corpus_index_counts.
 *
 * Lives outside the inngest/ tree so a thin smoke CLI can call it
 * without needing the inngest package (only the Cloud Run / production
 * inngest:serve process loads inngest).
 *
 * Standalone CLI: `tsx src/lib/corpus-counts-snapshot.ts`
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { getDb, getGamesDb } from '../db';

export interface SnapshotRow {
  source: 'chess.com' | 'lichess';
  distinct_handles: number;
  total_games: number;
}

export async function takeCorpusCountsSnapshot(): Promise<SnapshotRow[]> {
  const { client: gamesClient } = getGamesDb();
  const { client: supaClient } = getDb();
  try {
    // Distinct handles = handles that have appeared as either white or
    // black in any ingested game. This is the real "accounts indexed"
    // count — the games-corpus `handles` table only contains rows for
    // handles that features:run has fingerprinted, which is a much
    // smaller subset.
    const snapshots: SnapshotRow[] = [];
    for (const src of ['chess.com', 'lichess'] as const) {
      const distinct = await gamesClient<{ n: string }[]>`
        SELECT COUNT(DISTINCT h)::text AS n FROM (
          SELECT LOWER(white_handle_snapshot) AS h FROM games
            WHERE source = ${src} AND white_handle_snapshot IS NOT NULL
          UNION
          SELECT LOWER(black_handle_snapshot) FROM games
            WHERE source = ${src} AND black_handle_snapshot IS NOT NULL
        ) t
      `;
      const games = await gamesClient<{ n: string }[]>`
        SELECT COUNT(*)::text AS n FROM games WHERE source = ${src}
      `;
      snapshots.push({
        source: src,
        distinct_handles: Number.parseInt(distinct[0]!.n, 10),
        total_games: Number.parseInt(games[0]!.n, 10),
      });
    }

    await supaClient`
      INSERT INTO corpus_index_counts ${supaClient(snapshots, 'source', 'distinct_handles', 'total_games')}
    `;
    return snapshots;
  } finally {
    await gamesClient.end({ timeout: 5 });
    await supaClient.end({ timeout: 5 });
  }
}

// CLI smoke / manual trigger:
//   tsx src/lib/corpus-counts-snapshot.ts
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  takeCorpusCountsSnapshot()
    .then((snapshots) => {
      console.log('[corpus-counts] snapshot written:');
      for (const s of snapshots) {
        console.log(
          `  ${s.source.padEnd(12)} ${s.distinct_handles.toLocaleString()} handles · ${s.total_games.toLocaleString()} games`,
        );
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error('[corpus-counts] failed:', err);
      process.exit(1);
    });
}
