/**
 * Backfill style_features for the entire games corpus, across both
 * source platforms (lichess + chess.com). One fingerprint per
 * (platform, handle) pair — i.e. a player with both a lichess and a
 * chess.com account gets two fingerprints. That's intentional: Stage 3
 * matches against handles, not personas.
 *
 *  1. Stream every games row into memory, grouped by (platform, handle).
 *  2. Skip groups with fewer than --min-games (default 10) — feature
 *     vectors below that are too noisy to be useful.
 *  3. Upsert each (platform, handle) into `handles` to get its uuid.
 *  4. Compute V0 features per group (pure fn, platform-agnostic).
 *  5. Batch-upsert into `style_features`.
 *
 * Idempotent: re-runs replace style_features rows for the same handle.
 *
 * Usage:
 *   pnpm --filter @chessco/workers features:run                    # all handles >= 10 games
 *   pnpm --filter @chessco/workers features:run --min-games 5
 *   pnpm --filter @chessco/workers features:run --source lichess   # one platform only
 *   pnpm --filter @chessco/workers features:run --handle gelfand   # match across platforms
 */
import 'dotenv/config';
import type postgres from 'postgres';
import { getGamesDb } from '../db';
import { extractFeaturesV0, type GameRow } from './extract';

type Source = 'lichess' | 'chess.com';

interface CliArgs {
  minGames: number;
  filterHandle: string | null;
  sources: Source[];
}

function parseArgs(argv: string[]): CliArgs {
  let minGames = 10;
  let filterHandle: string | null = null;
  let sources: Source[] = ['lichess', 'chess.com'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--min-games' && argv[i + 1]) {
      minGames = Number.parseInt(argv[++i]!, 10);
    } else if (a === '--handle' && argv[i + 1]) {
      filterHandle = argv[++i]!.toLowerCase();
    } else if (a === '--source' && argv[i + 1]) {
      const s = argv[++i]!;
      if (s !== 'lichess' && s !== 'chess.com') {
        throw new Error(`--source must be 'lichess' or 'chess.com', got ${s}`);
      }
      sources = [s];
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }
  return { minGames, filterHandle, sources };
}

interface RawGameRow {
  source: Source;
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
  // Stockfish-derived per-game aggregates (Phase 1 W5). Null until the
  // backfill worker analyzes the row.
  mean_cp_loss: string | null;
  mean_cp_loss_white: string | null;
  mean_cp_loss_black: string | null;
  blunder_count: number | null;
  plies_analyzed: number | null;
}

/** postgres-js returns numeric columns as strings. Cast safely. */
function numOrNull(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Composite key encoding (platform, handle). Stable, human-readable. */
function groupKey(source: Source, handle: string): string {
  return `${source}::${handle}`;
}
function parseGroupKey(key: string): { source: Source; handle: string } {
  const idx = key.indexOf('::');
  return { source: key.slice(0, idx) as Source, handle: key.slice(idx + 2) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[features] sources=[${args.sources.join(',')}] min-games=${args.minGames} ` +
      `handle=${args.filterHandle ?? '(all)'}`,
  );

  const { client } = getGamesDb();
  try {
    // ---- 1. Stream games into memory ------------------------------------
    const t0 = Date.now();
    // `args.sources` is validated by parseArgs to be a non-empty subset of
    // {'lichess', 'chess.com'}, so we can interpolate via the IN helper
    // without worrying about injection.
    const sourceList = client(args.sources);
    const rows = await (args.filterHandle
      ? client<RawGameRow[]>`
          SELECT source,
            white_handle_snapshot, black_handle_snapshot,
            white_rating, black_rating,
            result, time_class, opening_eco, ply_count, termination, played_at,
            mean_cp_loss, mean_cp_loss_white, mean_cp_loss_black,
            blunder_count, plies_analyzed
          FROM games
          WHERE source IN ${sourceList}
            AND (LOWER(white_handle_snapshot) = ${args.filterHandle}
                 OR LOWER(black_handle_snapshot) = ${args.filterHandle})
        `
      : client<RawGameRow[]>`
          SELECT source,
            white_handle_snapshot, black_handle_snapshot,
            white_rating, black_rating,
            result, time_class, opening_eco, ply_count, termination, played_at,
            mean_cp_loss, mean_cp_loss_white, mean_cp_loss_black,
            blunder_count, plies_analyzed
          FROM games
          WHERE source IN ${sourceList}
        `);
    console.log(
      `[features] loaded ${rows.length.toLocaleString()} games in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );

    // ---- 2. Group by (platform, handle) --------------------------------
    const byHandle = new Map<string, GameRow[]>();
    for (const r of rows) {
      const playedAt = new Date(r.played_at);
      const meanCp = numOrNull(r.mean_cp_loss);
      const meanCpW = numOrNull(r.mean_cp_loss_white);
      const meanCpB = numOrNull(r.mean_cp_loss_black);
      if (r.white_handle_snapshot) {
        const k = groupKey(r.source, r.white_handle_snapshot.toLowerCase());
        const list = byHandle.get(k) ?? [];
        list.push({
          color: 'white',
          result: r.result,
          time_class: r.time_class,
          opening_eco: r.opening_eco,
          ply_count: r.ply_count,
          termination: r.termination,
          opponent_rating: r.black_rating,
          played_at: playedAt,
          mean_cp_loss: meanCp,
          mean_cp_loss_white: meanCpW,
          mean_cp_loss_black: meanCpB,
          blunder_count: r.blunder_count,
          plies_analyzed: r.plies_analyzed,
        });
        byHandle.set(k, list);
      }
      if (r.black_handle_snapshot) {
        const k = groupKey(r.source, r.black_handle_snapshot.toLowerCase());
        const list = byHandle.get(k) ?? [];
        list.push({
          color: 'black',
          result: r.result,
          time_class: r.time_class,
          opening_eco: r.opening_eco,
          ply_count: r.ply_count,
          termination: r.termination,
          opponent_rating: r.white_rating,
          played_at: playedAt,
          mean_cp_loss: meanCp,
          mean_cp_loss_white: meanCpW,
          mean_cp_loss_black: meanCpB,
          blunder_count: r.blunder_count,
          plies_analyzed: r.plies_analyzed,
        });
        byHandle.set(k, list);
      }
    }
    const breakdown = countBySource(byHandle);
    console.log(
      `[features] grouped into ${byHandle.size.toLocaleString()} (platform, handle) pairs ` +
        `(${breakdown.lichess.toLocaleString()} lichess, ${breakdown['chess.com'].toLocaleString()} chess.com)`,
    );

    const qualified = [...byHandle.entries()].filter(([, gs]) => gs.length >= args.minGames);
    console.log(
      `[features] ${qualified.length.toLocaleString()} pairs with >= ${args.minGames} games`,
    );

    if (qualified.length === 0) {
      console.log('[features] nothing to do.');
      return;
    }

    // ---- 3. Upsert handles, get their uuids ----------------------------
    const handlesUpsertT = Date.now();
    const handleRows = qualified.map(([key, games]) => {
      const { source, handle } = parseGroupKey(key);
      return {
        platform: source,
        handle,
        games_seen: games.length,
        first_seen_at: minDate(games).toISOString(),
        last_seen_at: maxDate(games).toISOString(),
      };
    });

    const insert = client as unknown as (
      rs: object[],
      ...cs: string[]
    ) => postgres.Helper<object[]>;
    const handleIds = await client<{ id: string; platform: string; handle: string }[]>`
      INSERT INTO handles
        ${insert(handleRows, 'platform', 'handle', 'games_seen', 'first_seen_at', 'last_seen_at')}
      ON CONFLICT (platform, handle) DO UPDATE SET
        games_seen = GREATEST(handles.games_seen, EXCLUDED.games_seen),
        first_seen_at = LEAST(handles.first_seen_at, EXCLUDED.first_seen_at),
        last_seen_at = GREATEST(handles.last_seen_at, EXCLUDED.last_seen_at)
      RETURNING id, platform, handle
    `;
    console.log(
      `[features] upserted ${handleIds.length.toLocaleString()} handles in ${((Date.now() - handlesUpsertT) / 1000).toFixed(1)}s`,
    );
    const handleIdByKey = new Map(
      handleIds.map((r) => [groupKey(r.platform as Source, r.handle), r.id]),
    );

    // ---- 4. Compute features -------------------------------------------
    const featuresT = Date.now();
    const featureRows = qualified
      .map(([key, games]) => {
        const playerId = handleIdByKey.get(key);
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

function countBySource(byHandle: Map<string, GameRow[]>): Record<Source, number> {
  const counts: Record<Source, number> = { lichess: 0, 'chess.com': 0 };
  for (const k of byHandle.keys()) {
    const { source } = parseGroupKey(k);
    counts[source]++;
  }
  return counts;
}

main().catch((err) => {
  console.error('features:run failed:', err);
  process.exit(1);
});
