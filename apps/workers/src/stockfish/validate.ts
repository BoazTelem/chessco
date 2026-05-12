/**
 * Cp-loss signal validation.
 *
 * Question we're trying to answer empirically: does mean_cp_loss vary
 * meaningfully *between* handles while staying consistent *within* a handle?
 * If yes → cp-loss is a discriminative fingerprint feature, full backfill
 * justified. If no → it's noise, pivot to other features.
 *
 * Method:
 *   1. Sample N handles, each with >= --games-per-handle PGN-populated games.
 *   2. For each handle, analyze K random games at depth --depth.
 *   3. Report per-handle (mean ± stddev) and overall (between/within ratio).
 *
 * The between/within variance ratio is the key signal:
 *   ≥ 2.0 → strongly discriminative
 *   1.0–2.0 → weak signal, useful as one ingredient
 *   < 1.0 → noise, drop the feature
 *
 *   pnpm --filter @chessco/workers exec tsx src/stockfish/validate.ts \
 *     --handles 20 --games-per-handle 5 --depth 6
 */
import 'dotenv/config';
import { getGamesDb } from '../db';
import { analyzeGame } from '../lib/analyze-game';
import { StockfishEngine } from '../lib/stockfish';

interface CliArgs {
  handles: number;
  gamesPerHandle: number;
  depth: number;
}

function parseArgs(argv: string[]): CliArgs {
  let handles = 20;
  let gamesPerHandle = 5;
  let depth = 6;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--handles' && argv[i + 1]) handles = parseInt(argv[++i]!, 10);
    else if (a === '--games-per-handle' && argv[i + 1]) gamesPerHandle = parseInt(argv[++i]!, 10);
    else if (a === '--depth' && argv[i + 1]) depth = parseInt(argv[++i]!, 10);
    else throw new Error(`unknown arg: ${a}`);
  }
  return { handles, gamesPerHandle, depth };
}

function meanStdDev(xs: number[]): { mean: number; stddev: number } {
  if (xs.length === 0) return { mean: NaN, stddev: NaN };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance =
    xs.length > 1 ? xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1) : 0;
  return { mean, stddev: Math.sqrt(variance) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[validate] handles=${args.handles} games-per-handle=${args.gamesPerHandle} depth=${args.depth}`,
  );

  const { client } = getGamesDb();

  // Pick handles with enough analyzable games. Use SUM of (white|black) appearances.
  type HandleRow = { handle: string; n_games: number };
  const handles = await client<HandleRow[]>`
    WITH counts AS (
      SELECT LOWER(white_handle_snapshot) AS handle, COUNT(*) AS n
      FROM games
      WHERE length(pgn) > 0 AND ply_count BETWEEN 25 AND 120
        AND white_handle_snapshot IS NOT NULL
      GROUP BY LOWER(white_handle_snapshot)
      UNION ALL
      SELECT LOWER(black_handle_snapshot) AS handle, COUNT(*) AS n
      FROM games
      WHERE length(pgn) > 0 AND ply_count BETWEEN 25 AND 120
        AND black_handle_snapshot IS NOT NULL
      GROUP BY LOWER(black_handle_snapshot)
    )
    SELECT handle, SUM(n)::int AS n_games
    FROM counts
    GROUP BY handle
    HAVING SUM(n) >= ${args.gamesPerHandle}
    ORDER BY random()
    LIMIT ${args.handles}
  `;

  if (handles.length === 0) {
    console.log('[validate] no qualifying handles found.');
    await client.end({ timeout: 5 });
    return;
  }
  console.log(`[validate] picked ${handles.length} handles`);

  const sf = await StockfishEngine.start('lite-single');
  const t0 = Date.now();

  const perHandle: Array<{ handle: string; cpLosses: number[]; ratings: number[] }> = [];
  for (const h of handles) {
    type GameRow = {
      pgn: string;
      color: 'white' | 'black';
      opp_rating: number | null;
      own_rating: number | null;
    };
    const games = await client<GameRow[]>`
      SELECT
        pgn,
        CASE WHEN LOWER(white_handle_snapshot) = ${h.handle} THEN 'white' ELSE 'black' END AS color,
        CASE WHEN LOWER(white_handle_snapshot) = ${h.handle} THEN black_rating ELSE white_rating END AS opp_rating,
        CASE WHEN LOWER(white_handle_snapshot) = ${h.handle} THEN white_rating ELSE black_rating END AS own_rating
      FROM games
      WHERE length(pgn) > 0 AND ply_count BETWEEN 25 AND 120
        AND (LOWER(white_handle_snapshot) = ${h.handle} OR LOWER(black_handle_snapshot) = ${h.handle})
      ORDER BY random()
      LIMIT ${args.gamesPerHandle}
    `;

    const cpLosses: number[] = [];
    const ratings: number[] = [];
    for (const g of games) {
      const a = await analyzeGame(sf, g.pgn, { depth: args.depth });
      // Use the per-side cp-loss matching the handle's color, so we're scoring
      // their moves, not the opponent's.
      const side = g.color === 'white' ? a.mean_cp_loss_white : a.mean_cp_loss_black;
      if (side != null) cpLosses.push(side);
      if (g.own_rating != null) ratings.push(g.own_rating);
    }
    if (cpLosses.length > 0) {
      perHandle.push({ handle: h.handle, cpLosses, ratings });
      const { mean, stddev } = meanStdDev(cpLosses);
      const ratingTag =
        ratings.length > 0 ? ` (rating≈${Math.round(meanStdDev(ratings).mean)})` : '';
      console.log(
        `[validate] ${h.handle.padEnd(20)} mean=${mean.toFixed(1).padStart(5)} ± ${stddev.toFixed(1).padStart(4)}  n=${cpLosses.length}${ratingTag}`,
      );
    }
  }

  await sf.quit();

  // ---- Aggregate analysis ----
  const allCpLosses = perHandle.flatMap((h) => h.cpLosses);
  const overall = meanStdDev(allCpLosses);
  const handleMeans = perHandle.map((h) => meanStdDev(h.cpLosses).mean);
  const betweenHandleStd = meanStdDev(handleMeans).stddev;
  const withinHandleStds = perHandle.map((h) => meanStdDev(h.cpLosses).stddev);
  const meanWithinStd = withinHandleStds.reduce((a, b) => a + b, 0) / withinHandleStds.length;
  const ratio = meanWithinStd > 0 ? betweenHandleStd / meanWithinStd : Infinity;

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n========= summary =========');
  console.log(`elapsed:           ${dt}s`);
  console.log(`handles analyzed:  ${perHandle.length}`);
  console.log(`games analyzed:    ${allCpLosses.length}`);
  console.log(`overall mean ± sd: ${overall.mean.toFixed(1)} ± ${overall.stddev.toFixed(1)}`);
  console.log(`between-handle σ:  ${betweenHandleStd.toFixed(1)}  (how different handles are)`);
  console.log(`within-handle σ:   ${meanWithinStd.toFixed(1)}  (noise inside one handle)`);
  console.log(`signal/noise:      ${ratio.toFixed(2)}  (≥2.0 strong, 1–2 weak, <1 noise)`);
  console.log('===========================');

  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('[validate] failed:', err);
  process.exit(1);
});
