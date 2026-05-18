/**
 * FIDE-source fingerprint builder (Phase 1 step 5).
 *
 * Reads games we've already ingested from external_pgn_sources via the
 * Phase-1 pipeline (TWIC and future sources) and produces:
 *
 *   - one `handles` row keyed by (platform='fide', handle=federation_player_id)
 *   - one `style_features` row per qualifying FIDE player (V0 JSONB)
 *   - one `account_fingerprints` row per qualifying FIDE player (scalar
 *     prefilter denorm so the matcher's Stage A filter works the same as
 *     for chess.com / lichess accounts)
 *   - sparse `fingerprint_terms` rows so the cascade's Stage B retrieval
 *     covers FIDE players too
 *
 * With this in place, Path B (paste PGN → identify) can land on a FIDE
 * player whose chess.com / lichess accounts are anonymous or unknown — the
 * cascade matches against the FIDE-platform fingerprint built from TWIC
 * games. After step 5 lands, /scout result cards can also surface "Games
 * we already have for {FIDE name}" using the same external_pgn_sources
 * back-link.
 *
 * Architecture mirror with apps/workers/src/features/run.ts:
 *   - reuses extractFeaturesV0 + extractFingerprintTerms (the V0
 *     extraction is platform-agnostic; only the grouping changes)
 *   - upserts into the same three tables — handles, style_features,
 *     account_fingerprints, plus fingerprint_terms — keyed by uuid so the
 *     existing cascade reads them automatically
 *   - groups games by federation_player_id (single dimension; same person
 *     across all sources gets ONE 'fide' fingerprint, not per-source)
 *
 * Usage:
 *   pnpm --filter @chessco/workers external:fingerprint
 *   pnpm --filter @chessco/workers external:fingerprint -- --min-games 10
 *   pnpm --filter @chessco/workers external:fingerprint -- --source twic
 *   pnpm --filter @chessco/workers external:fingerprint -- --fide-id <uuid>
 *
 * Idempotent: re-runs overwrite the FIDE player's fingerprint with the
 * latest games window.
 */
import 'dotenv/config';
import { Chess } from 'chess.js';
import type postgres from 'postgres';
import { getGamesDb } from '../db';
import {
  extractFeaturesV0,
  extractFingerprintTerms,
  type FingerprintTerm,
  type GameRow,
} from '../features/extract';
import type { PlayerFeaturesV0 } from '../features/types';

const MOVE_SEQ_PLY_COUNT = 12;
const DEFAULT_MIN_GAMES = 10;

interface CliArgs {
  minGames: number;
  source: string | null;
  fideId: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { minGames: DEFAULT_MIN_GAMES, source: null, fideId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    else if (a === '--min-games' && argv[i + 1]) out.minGames = Number.parseInt(argv[++i]!, 10);
    else if (a === '--source' && argv[i + 1]) out.source = argv[++i]!;
    else if (a === '--fide-id' && argv[i + 1]) out.fideId = argv[++i]!;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return out;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

interface RawJoinRow {
  fide_id_white: string | null;
  fide_id_black: string | null;
  source: string;
  white_rating: number | null;
  black_rating: number | null;
  result: '1-0' | '0-1' | '1/2-1/2';
  time_class: string | null;
  opening_eco: string | null;
  ply_count: number;
  termination: string | null;
  played_at: string;
  mean_cp_loss: string | null;
  mean_cp_loss_white: string | null;
  mean_cp_loss_black: string | null;
  blunder_count: number | null;
  plies_analyzed: number | null;
  pgn: string | null;
}

function numOrNull(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pgnToMoveSeqPrefix(pgn: string | null, plyCount = MOVE_SEQ_PLY_COUNT): string {
  if (!pgn || pgn.length === 0) return '';
  const chess = new Chess();
  try {
    chess.loadPgn(pgn, { strict: false });
  } catch {
    return '';
  }
  const history = chess.history();
  if (history.length === 0) return '';
  return history.slice(0, plyCount).join(' ');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[external-fingerprint] min-games=${args.minGames}` +
      `${args.source ? ` source=${args.source}` : ''}` +
      `${args.fideId ? ` fide-id=${args.fideId}` : ''}`,
  );

  const { client } = getGamesDb();
  try {
    // ---- 1. Pull all games linked to a FIDE player via external_pgn_sources
    const t0 = Date.now();
    const rows = await client<RawJoinRow[]>`
      SELECT
        eps.white_fide_id::text AS fide_id_white,
        eps.black_fide_id::text AS fide_id_black,
        eps.source,
        g.white_rating, g.black_rating,
        g.result, g.time_class, g.opening_eco, g.ply_count,
        g.termination, g.played_at::text AS played_at,
        g.mean_cp_loss, g.mean_cp_loss_white, g.mean_cp_loss_black,
        g.blunder_count, g.plies_analyzed,
        g.pgn
      FROM external_pgn_sources eps
      JOIN games g ON g.id = eps.game_id
      WHERE eps.game_id IS NOT NULL
        AND (eps.white_fide_id IS NOT NULL OR eps.black_fide_id IS NOT NULL)
        AND g.result IN ('1-0', '0-1', '1/2-1/2')
        ${args.source ? client`AND eps.source = ${args.source}` : client``}
        ${args.fideId ? client`AND (eps.white_fide_id = ${args.fideId}::uuid OR eps.black_fide_id = ${args.fideId}::uuid)` : client``}
    `;
    console.log(
      `[external-fingerprint] loaded ${fmt(rows.length)} game rows in ` +
        `${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );

    if (rows.length === 0) {
      console.log('[external-fingerprint] nothing to do.');
      return;
    }

    // ---- 2. Group by federation_player_id ------------------------------
    const byFideId = new Map<string, GameRow[]>();
    let seqParsed = 0;
    let seqEmpty = 0;
    for (const r of rows) {
      const playedAt = new Date(r.played_at);
      const meanCp = numOrNull(r.mean_cp_loss);
      const meanCpW = numOrNull(r.mean_cp_loss_white);
      const meanCpB = numOrNull(r.mean_cp_loss_black);
      const moveSeq = pgnToMoveSeqPrefix(r.pgn);
      if (moveSeq.length > 0) seqParsed++;
      else seqEmpty++;

      if (r.fide_id_white) {
        const list = byFideId.get(r.fide_id_white) ?? [];
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
          move_seq_prefix: moveSeq,
        });
        byFideId.set(r.fide_id_white, list);
      }
      if (r.fide_id_black) {
        const list = byFideId.get(r.fide_id_black) ?? [];
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
          move_seq_prefix: moveSeq,
        });
        byFideId.set(r.fide_id_black, list);
      }
    }
    console.log(
      `[external-fingerprint] parsed move-seq for ${fmt(seqParsed)} games ` +
        `(${fmt(seqEmpty)} unparseable)`,
    );
    console.log(`[external-fingerprint] grouped into ${fmt(byFideId.size)} distinct FIDE players`);

    const qualified = [...byFideId.entries()].filter(([, gs]) => gs.length >= args.minGames);
    console.log(
      `[external-fingerprint] ${fmt(qualified.length)} players with >= ${args.minGames} games`,
    );

    if (qualified.length === 0) {
      console.log('[external-fingerprint] no FIDE players have enough games yet.');
      return;
    }

    // ---- 3. Upsert handles with platform='fide' ------------------------
    const handlesT = Date.now();
    const handleRows = qualified.map(([fideId, games]) => ({
      platform: 'fide',
      handle: fideId,
      games_seen: games.length,
      first_seen_at: minDate(games).toISOString(),
      last_seen_at: maxDate(games).toISOString(),
    }));

    const insert = client as unknown as (
      rs: object[],
      ...cs: string[]
    ) => postgres.Helper<object[]>;

    const HANDLES_CHUNK = 10000;
    const handleIds: { id: string; handle: string }[] = [];
    for (let i = 0; i < handleRows.length; i += HANDLES_CHUNK) {
      const chunk = handleRows.slice(i, i + HANDLES_CHUNK);
      const result = await client<{ id: string; platform: string; handle: string }[]>`
        INSERT INTO handles
          ${insert(chunk, 'platform', 'handle', 'games_seen', 'first_seen_at', 'last_seen_at')}
        ON CONFLICT (platform, handle) DO UPDATE SET
          games_seen = GREATEST(handles.games_seen, EXCLUDED.games_seen),
          first_seen_at = LEAST(handles.first_seen_at, EXCLUDED.first_seen_at),
          last_seen_at = GREATEST(handles.last_seen_at, EXCLUDED.last_seen_at)
        RETURNING id, platform, handle
      `;
      handleIds.push(...result);
    }
    console.log(
      `[external-fingerprint] upserted ${fmt(handleIds.length)} fide handles in ` +
        `${((Date.now() - handlesT) / 1000).toFixed(1)}s`,
    );
    const handleIdByFide = new Map(handleIds.map((r) => [r.handle, r.id]));

    // ---- 4. Compute features + terms + account_fingerprints ------------
    interface ComputeRow {
      handleId: string;
      fideId: string;
      gamesWindow: number;
      features: PlayerFeaturesV0;
      featuresJson: string;
      dominantTimeClass: string | null;
      whiteShare: number;
      terms: FingerprintTerm[];
    }
    const featuresT = Date.now();
    const computed: ComputeRow[] = [];
    for (const [fideId, games] of qualified) {
      const handleId = handleIdByFide.get(fideId);
      if (!handleId) continue;
      const features = extractFeaturesV0(games);
      const terms = extractFingerprintTerms(features);
      computed.push({
        handleId,
        fideId,
        gamesWindow: games.length,
        features,
        featuresJson: JSON.stringify(features),
        dominantTimeClass: argmaxKey(features.time_class),
        whiteShare: features.games_total > 0 ? features.games_as_white / features.games_total : 0,
        terms,
      });
    }
    console.log(
      `[external-fingerprint] computed ${fmt(computed.length)} feature vectors in ` +
        `${((Date.now() - featuresT) / 1000).toFixed(1)}s`,
    );

    // ---- 5a. style_features ---------------------------------------------
    const sfT = Date.now();
    const SF_CHUNK = 5000;
    let sfUpserted = 0;
    for (let i = 0; i < computed.length; i += SF_CHUNK) {
      const chunk = computed.slice(i, i + SF_CHUNK).map((r) => ({
        player_id: r.handleId,
        features: r.featuresJson,
        games_window: r.gamesWindow,
      }));
      const result = await client<{ player_id: string }[]>`
        INSERT INTO style_features
          ${insert(chunk, 'player_id', 'features', 'games_window')}
        ON CONFLICT (player_id) DO UPDATE SET
          features = EXCLUDED.features,
          games_window = EXCLUDED.games_window,
          computed_at = NOW()
        RETURNING player_id
      `;
      sfUpserted += result.length;
    }
    console.log(
      `[external-fingerprint] upserted ${fmt(sfUpserted)} style_features rows in ` +
        `${((Date.now() - sfT) / 1000).toFixed(1)}s`,
    );

    // ---- 5b. account_fingerprints ---------------------------------------
    const afT = Date.now();
    const AF_CHUNK = 3000;
    let afUpserted = 0;
    for (let i = 0; i < computed.length; i += AF_CHUNK) {
      const chunk = computed.slice(i, i + AF_CHUNK).map((r) => ({
        handle_id: r.handleId,
        platform: 'fide',
        handle: r.fideId,
        games_window: r.gamesWindow,
        median_rating:
          r.features.avg_opponent_rating === null
            ? null
            : Math.round(r.features.avg_opponent_rating),
        rating_blitz: null,
        rating_rapid: null,
        rating_classical: null,
        country: null,
        title: null,
        dominant_time_class: r.dominantTimeClass,
        white_share: r.whiteShare,
        earliest_played_at: r.features.earliest_played_at,
        latest_played_at: r.features.latest_played_at,
        scalar_summary: r.featuresJson,
      }));
      const result = await client<{ handle_id: string }[]>`
        INSERT INTO account_fingerprints
          ${insert(
            chunk,
            'handle_id',
            'platform',
            'handle',
            'games_window',
            'median_rating',
            'rating_blitz',
            'rating_rapid',
            'rating_classical',
            'country',
            'title',
            'dominant_time_class',
            'white_share',
            'earliest_played_at',
            'latest_played_at',
            'scalar_summary',
          )}
        ON CONFLICT (handle_id) DO UPDATE SET
          games_window = EXCLUDED.games_window,
          median_rating = EXCLUDED.median_rating,
          dominant_time_class = EXCLUDED.dominant_time_class,
          white_share = EXCLUDED.white_share,
          earliest_played_at = EXCLUDED.earliest_played_at,
          latest_played_at = EXCLUDED.latest_played_at,
          scalar_summary = EXCLUDED.scalar_summary,
          built_at = NOW()
        RETURNING handle_id
      `;
      afUpserted += result.length;
    }
    console.log(
      `[external-fingerprint] upserted ${fmt(afUpserted)} account_fingerprints rows in ` +
        `${((Date.now() - afT) / 1000).toFixed(1)}s`,
    );

    // ---- 5c. fingerprint_terms ------------------------------------------
    const termsT = Date.now();
    const handleIdsAll = computed.map((r) => r.handleId);
    const DELETE_CHUNK = 5000;
    for (let i = 0; i < handleIdsAll.length; i += DELETE_CHUNK) {
      const ids = handleIdsAll.slice(i, i + DELETE_CHUNK);
      await client`DELETE FROM fingerprint_terms WHERE handle_id = ANY(${ids}::uuid[])`;
    }

    const allTerms = computed.flatMap((r) =>
      r.terms.map((t) => ({
        handle_id: r.handleId,
        kind: t.kind,
        term: t.term,
        weight: t.weight,
      })),
    );
    const TERM_CHUNK = 10000;
    let termsUpserted = 0;
    for (let i = 0; i < allTerms.length; i += TERM_CHUNK) {
      const chunk = allTerms.slice(i, i + TERM_CHUNK);
      const result = await client<{ handle_id: string }[]>`
        INSERT INTO fingerprint_terms
          ${insert(chunk, 'handle_id', 'kind', 'term', 'weight')}
        ON CONFLICT (handle_id, kind, term) DO UPDATE SET
          weight = EXCLUDED.weight
        RETURNING handle_id
      `;
      termsUpserted += result.length;
    }
    console.log(
      `[external-fingerprint] upserted ${fmt(termsUpserted)} fingerprint_terms rows ` +
        `(${fmt(computed.length)} players) in ${((Date.now() - termsT) / 1000).toFixed(1)}s`,
    );

    const totalDt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n[external-fingerprint] DONE in ${totalDt}s`);
    console.log(`  game rows joined:                 ${fmt(rows.length)}`);
    console.log(`  distinct FIDE players:            ${fmt(byFideId.size)}`);
    console.log(`  qualified (>= ${args.minGames} games):       ${fmt(qualified.length)}`);
    console.log(`  fingerprints written:             ${fmt(computed.length)}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

function argmaxKey(record: Record<string, number>): string | null {
  let bestKey: string | null = null;
  let bestVal = -Infinity;
  for (const [k, v] of Object.entries(record)) {
    if (v > bestVal) {
      bestVal = v;
      bestKey = k;
    }
  }
  return bestKey;
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
  console.error('external-fingerprint failed:', err);
  process.exit(1);
});
