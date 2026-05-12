/**
 * Backfill style_features for the entire games corpus.
 *
 *  1. Stream all games once (currently lichess-only) into memory grouped
 *     by handle. ~68k games × ~250 B per row = ~17 MB; fits comfortably.
 *  2. Skip handles with fewer than --min-games (default 10) — feature
 *     vectors below that are too noisy to be useful.
 *  3. Upsert each handle into `handles` to get its uuid.
 *  4. Compute V0 features per handle (pure fn).
 *  5. Batch-upsert into `style_features`.
 *
 * Idempotent: re-runs replace style_features rows for the same handle.
 *
 * Usage:
 *   pnpm --filter @chessco/workers features:run                    # all handles >= 10 games
 *   pnpm --filter @chessco/workers features:run --min-games 5
 *   pnpm --filter @chessco/workers features:run --handle gelfand   # one handle, for debugging
 */
import 'dotenv/config';
import type postgres from 'postgres';
import { getGamesDb } from '../db';
import { extractFeaturesV0, type GameRow } from './extract';

interface CliArgs {
  minGames: number;
  filterHandle: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  let minGames = 10;
  let filterHandle: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--min-games' && argv[i + 1]) {
      minGames = Number.parseInt(argv[++i]!, 10);
    } else if (a === '--handle' && argv[i + 1]) {
      filterHandle = argv[++i]!.toLowerCase();
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }
  return { minGames, filterHandle };
}

interface RawGameRow {
  white_handle_snapshot: string | null;
  black_handle_snapshot: string | null;
  white_rating: number | null;
  black_rating: number | null;
  result: '1-0' | '0-1' | '1/2-1/2';
  time_class: string | null;
  opening_eco: string | null;
  ply_count: number;
  termination: string | null;
  /** postgres-js with prepare:false returns timestamptz as ISO string. */
  played_at: string;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[features] min-games=${args.minGames} handle=${args.filterHandle ?? '(all)'}`);

  const { client } = getGamesDb();
  try {
    // ---- 1. Stream games into memory ------------------------------------
    const t0 = Date.now();
    const rows = await client<RawGameRow[]>`
      SELECT
        white_handle_snapshot, black_handle_snapshot,
        white_rating, black_rating,
        result, time_class, opening_eco, ply_count, termination, played_at
      FROM games WHERE source = 'lichess'
        ${args.filterHandle ? client`AND (LOWER(white_handle_snapshot) = ${args.filterHandle} OR LOWER(black_handle_snapshot) = ${args.filterHandle})` : client``}
    `;
    console.log(
      `[features] loaded ${rows.length.toLocaleString()} games in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );

    // ---- 2. Group by handle --------------------------------------------
    const byHandle = new Map<string, GameRow[]>();
    for (const r of rows) {
      // ingest already filters out unfinished games ('*'), but the
      // declared type includes only finished results, so we just trust it.
      const playedAt = new Date(r.played_at);
      if (r.white_handle_snapshot) {
        const h = r.white_handle_snapshot.toLowerCase();
        const list = byHandle.get(h) ?? [];
        list.push({
          color: 'white',
          result: r.result,
          time_class: r.time_class,
          opening_eco: r.opening_eco,
          ply_count: r.ply_count,
          termination: r.termination,
          opponent_rating: r.black_rating,
          played_at: playedAt,
        });
        byHandle.set(h, list);
      }
      if (r.black_handle_snapshot) {
        const h = r.black_handle_snapshot.toLowerCase();
        const list = byHandle.get(h) ?? [];
        list.push({
          color: 'black',
          result: r.result,
          time_class: r.time_class,
          opening_eco: r.opening_eco,
          ply_count: r.ply_count,
          termination: r.termination,
          opponent_rating: r.white_rating,
          played_at: playedAt,
        });
        byHandle.set(h, list);
      }
    }
    console.log(`[features] grouped into ${byHandle.size.toLocaleString()} handles`);

    const qualified = [...byHandle.entries()].filter(([, gs]) => gs.length >= args.minGames);
    console.log(
      `[features] ${qualified.length.toLocaleString()} handles with >= ${args.minGames} games`,
    );

    if (qualified.length === 0) {
      console.log('[features] nothing to do.');
      return;
    }

    // ---- 3. Upsert handles, get their uuids ----------------------------
    const handlesUpsertT = Date.now();
    const handleRows = qualified.map(([handle, games]) => ({
      platform: 'lichess',
      handle,
      games_seen: games.length,
      first_seen_at: minDate(games).toISOString(),
      last_seen_at: maxDate(games).toISOString(),
    }));

    const insert = client as unknown as (
      rs: object[],
      ...cs: string[]
    ) => postgres.Helper<object[]>;
    const handleIds = await client<{ id: string; handle: string }[]>`
      INSERT INTO handles
        ${insert(handleRows, 'platform', 'handle', 'games_seen', 'first_seen_at', 'last_seen_at')}
      ON CONFLICT (platform, handle) DO UPDATE SET
        games_seen = GREATEST(handles.games_seen, EXCLUDED.games_seen),
        first_seen_at = LEAST(handles.first_seen_at, EXCLUDED.first_seen_at),
        last_seen_at = GREATEST(handles.last_seen_at, EXCLUDED.last_seen_at)
      RETURNING id, handle
    `;
    console.log(
      `[features] upserted ${handleIds.length.toLocaleString()} handles in ${((Date.now() - handlesUpsertT) / 1000).toFixed(1)}s`,
    );
    const handleIdByName = new Map(handleIds.map((r) => [r.handle, r.id]));

    // ---- 4. Compute features -------------------------------------------
    const featuresT = Date.now();
    const featureRows = qualified
      .map(([handle, games]) => {
        const playerId = handleIdByName.get(handle);
        if (!playerId) return null;
        const features = extractFeaturesV0(games);
        return {
          player_id: playerId,
          features: JSON.stringify(features),
          games_window: games.length,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    console.log(
      `[features] computed ${featureRows.length.toLocaleString()} feature vectors in ${((Date.now() - featuresT) / 1000).toFixed(1)}s`,
    );

    // ---- 5. Batch-upsert into style_features. Chunked to stay under
    //         the 65k Postgres parameter cap (3 cols × N rows). --------
    const upsertT = Date.now();
    const CHUNK = 5000;
    let upserted = 0;
    for (let i = 0; i < featureRows.length; i += CHUNK) {
      const chunk = featureRows.slice(i, i + CHUNK);
      const result = await client<{ player_id: string }[]>`
        INSERT INTO style_features
          ${insert(chunk, 'player_id', 'features', 'games_window')}
        ON CONFLICT (player_id) DO UPDATE SET
          features = EXCLUDED.features,
          games_window = EXCLUDED.games_window,
          computed_at = NOW()
        RETURNING player_id
      `;
      upserted += result.length;
    }
    console.log(
      `[features] upserted ${upserted.toLocaleString()} style_features rows in ${((Date.now() - upsertT) / 1000).toFixed(1)}s`,
    );

    const totalDt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[features] DONE in ${totalDt}s`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

function minDate(games: GameRow[]): Date {
  let m = games[0]!.played_at;
  for (const g of games) if (g.played_at < m) m = g.played_at;
  return m;
}
function maxDate(games: GameRow[]): Date {
  let m = games[0]!.played_at;
  for (const g of games) if (g.played_at > m) m = g.played_at;
  return m;
}

main().catch((err) => {
  console.error('features:run failed:', err);
  process.exit(1);
});
