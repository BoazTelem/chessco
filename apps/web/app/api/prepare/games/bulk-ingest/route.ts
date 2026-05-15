/**
 * POST /api/prepare/games/bulk-ingest — accept a batch of opponent games
 * the browser already fetched in OpeningTreeSection and persist them to
 * the games corpus so the prepare-reports poller can build repertoires
 * and run Stockfish backfill without waiting on the (slow, job-style)
 * lichess-crawl / chesscom-crawl workers.
 *
 * Pipeline:
 *   1. Auth + payload caps (size, game count, ply count).
 *   2. Per-game: validate handle membership, replay UCI moves to
 *      reconstruct full FENs, build ProcessedGame.
 *   3. Single transaction on the games DB: upsert handle, ingestBatch.
 *   4. In practice DB: reset any stale prep_report for this user/opponent
 *      so the poller re-evaluates with the fresh corpus state.
 *   5. Fire `chessco/prepare-reports.poll.requested` to wake the poller
 *      immediately instead of waiting up to 60s for the next cron tick.
 */
import { Chess } from 'chess.js';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { fenHash } from '@/lib/games-corpus/fen-hash';
import {
  ingestBatch,
  ingestBatchInTransaction,
  type GameRow,
  type MoveRow,
  type PositionRow,
  type ProcessedGame,
} from '@/lib/games-corpus/ingest';
import { upsertHandle } from '@/lib/games-corpus/upsert-handle';
import { getGamesDb } from '@/lib/games-db';
import { getPracticeDb } from '@/lib/practice/db';
import { sendEvent } from '@/lib/inngest';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_GAMES = 500;
const MAX_TOTAL_PLY = 30_000;
const MAX_PER_GAME_PLY = 400;

const GameInput = z.object({
  id: z.string().min(1),
  playedAt: z.union([z.string(), z.number(), z.date()]).transform((v) => new Date(v)),
  playerColor: z.enum(['white', 'black']),
  result: z.enum(['win', 'loss', 'draw']),
  resultText: z.enum(['1-0', '0-1', '1/2-1/2']),
  timeClass: z.enum(['bullet', 'blitz', 'rapid', 'classical', 'unknown']),
  whiteHandle: z.string(),
  blackHandle: z.string(),
  whiteElo: z.number().nullable(),
  blackElo: z.number().nullable(),
  movesSan: z.array(z.string()),
  movesUci: z.array(z.string()),
  fensBefore: z.array(z.string()),
});

const Input = z.object({
  platform: z.enum(['lichess', 'chess.com']),
  handle: z.string().trim().min(1).max(128),
  games: z.array(GameInput).min(1).max(MAX_GAMES),
});

type GameRecordInput = z.infer<typeof GameInput>;

export async function POST(req: Request): Promise<NextResponse> {
  // 1. Auth ----------------------------------------------------------------
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  // 2. Size guard before parsing the body --------------------------------
  const contentLengthHeader = req.headers.get('content-length');
  if (contentLengthHeader) {
    const length = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(length) && length > MAX_BYTES) {
      return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
    }
  }

  let body: z.infer<typeof Input>;
  try {
    const rawBody = await req.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BYTES) {
      return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
    }
    body = Input.parse(JSON.parse(rawBody));
  } catch (err) {
    const msg =
      err instanceof z.ZodError ? (err.issues[0]?.message ?? 'invalid input') : 'invalid JSON';
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const handleLower = body.handle.toLowerCase();

  // 3. Per-game validation + ProcessedGame construction --------------------
  const processed: ProcessedGame[] = [];
  const seenSourceGameIds = new Set<string>();
  let dropped = 0;
  let fenMismatchDropped = 0;
  let totalPly = 0;
  let earliest: Date | null = null;
  let latest: Date | null = null;

  for (const game of body.games) {
    if (game.movesSan.length !== game.movesUci.length) {
      dropped++;
      continue;
    }
    if (game.fensBefore.length !== game.movesSan.length) {
      dropped++;
      continue;
    }
    if (game.movesUci.length === 0 || game.movesUci.length > MAX_PER_GAME_PLY) {
      dropped++;
      continue;
    }
    const whiteLower = game.whiteHandle.toLowerCase();
    const blackLower = game.blackHandle.toLowerCase();
    if (whiteLower !== handleLower && blackLower !== handleLower) {
      // Anti-abuse: caller cannot smuggle unrelated games for a different player.
      dropped++;
      continue;
    }
    if (!Number.isFinite(game.playedAt.getTime())) {
      dropped++;
      continue;
    }

    totalPly += game.movesUci.length;
    if (totalPly > MAX_TOTAL_PLY) {
      return NextResponse.json({ error: 'ply_total_too_large' }, { status: 413 });
    }

    const sourceGameId = normalizeSourceGameId(body.platform, game.id);
    if (!sourceGameId) {
      dropped++;
      continue;
    }
    if (seenSourceGameIds.has(sourceGameId)) {
      dropped++;
      continue;
    }

    const pg = buildProcessedGame(body.platform, sourceGameId, game);
    if (!pg) {
      dropped++;
      if (hasFenMismatch(game)) fenMismatchDropped++;
      continue;
    }

    seenSourceGameIds.add(sourceGameId);
    processed.push(pg);
    if (!earliest || game.playedAt < earliest) earliest = game.playedAt;
    if (!latest || game.playedAt > latest) latest = game.playedAt;
  }

  if (processed.length === 0) {
    return NextResponse.json(
      { inserted: 0, deduped: 0, dropped, woke_report: false },
      { status: 200 },
    );
  }

  // 4. Ingest games + upsert handle ----------------------------------------
  const games = getGamesDb();
  let stats: Awaited<ReturnType<typeof ingestBatch>>;
  try {
    stats = await games.begin(async (tx) => {
      const out = await ingestBatchInTransaction(tx, processed);
      await upsertHandle(tx, {
        platform: body.platform,
        handle: handleLower,
        gamesSeen: processed.length,
        earliest: earliest ?? new Date(),
        latest: latest ?? new Date(),
      });
      return out;
    });
  } catch (err) {
    console.error('[bulk-ingest] ingestBatch failed:', err);
    return NextResponse.json({ error: 'ingest_failed' }, { status: 500 });
  }

  // 5. Reset stale prep_report row + wake poller --------------------------
  const woke = await wakePollerIfRelevant(user.id, body.platform, handleLower);
  if (fenMismatchDropped > 0) {
    console.warn(`[bulk-ingest] dropped ${fenMismatchDropped} game(s) for FEN mismatch`);
  }

  return NextResponse.json(
    {
      inserted: stats.games_inserted,
      deduped: stats.games_deduped,
      dropped,
      woke_report: woke,
    },
    { status: 200 },
  );
}

/**
 * Chess.com browser fetcher currently stores the full game URL in
 * `GameRecord.id` (see apps/web/lib/prepare/fetch-chesscom.ts:111), but
 * accept UUIDs too so this stays aligned with chesscom-crawl's
 * sourceIdFromArchive.
 *
 * Lichess game IDs are already the 8-char token; use as-is
 * (apps/workers/src/lichess-dumps/parse-game.ts:extractSourceGameId).
 */
function normalizeSourceGameId(platform: 'lichess' | 'chess.com', rawId: string): string | null {
  if (platform === 'lichess') {
    const trimmed = rawId.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  const trimmed = rawId.trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)) {
    return trimmed;
  }
  // chess.com URL fallback like https://www.chess.com/game/live/12345
  const m = /\/(\d+)(?:\?.*)?$/.exec(rawId);
  return m?.[1] ?? null;
}

/**
 * Replay UCI moves to reconstruct full 6-field FENs (the browser stores
 * 4-field normalized FENs only — they're fine for tree dedup but the
 * games corpus uses full FENs for hashing and indexing).
 *
 * Returns null if any move is illegal — that game is dropped rather than
 * partially ingested.
 */
function buildProcessedGame(
  platform: 'lichess' | 'chess.com',
  sourceGameId: string,
  game: GameRecordInput,
): ProcessedGame | null {
  const board = new Chess();

  const positions: PositionRow[] = [];
  const moves: MoveRow[] = [];

  const startFen = board.fen();
  positions.push({
    fen: startFen,
    fen_hash: fenHash(startFen),
    side_to_move: 'w',
    ply: 0,
    eco: null,
    opening_name: null,
  });

  for (let i = 0; i < game.movesUci.length; i++) {
    const uci = game.movesUci[i]!;
    const fenBefore = board.fen();
    if (normalizeFenKey(fenBefore) !== normalizeFenKey(game.fensBefore[i] ?? '')) {
      return null;
    }

    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    let result: { san: string; from: string; to: string; promotion?: string } | null = null;
    try {
      result = board.move({ from, to, promotion });
    } catch {
      return null;
    }
    if (!result) return null;

    const ply = i + 1;
    const fenAfter = board.fen();
    positions.push({
      fen: fenAfter,
      fen_hash: fenHash(fenAfter),
      side_to_move: fenAfter.split(' ')[1] === 'b' ? 'b' : 'w',
      ply,
      eco: null,
      opening_name: null,
    });

    moves.push({
      ply,
      san: result.san,
      uci,
      fen_before: fenBefore,
      fen_after: fenAfter,
      clock_white_ms: null,
      clock_black_ms: null,
      eval_cp: null,
      eval_mate: null,
    });
  }

  const timeClass: GameRow['time_class'] = game.timeClass === 'unknown' ? null : game.timeClass;

  const gameRow: GameRow = {
    source: platform,
    source_game_id: sourceGameId,
    white_handle_snapshot: game.whiteHandle.toLowerCase(),
    black_handle_snapshot: game.blackHandle.toLowerCase(),
    white_rating: game.whiteElo,
    black_rating: game.blackElo,
    pgn: '', // Browser didn't keep the raw PGN; matches chesscom-crawl's null-PGN fallback.
    initial_fen: null,
    result: game.resultText,
    termination: null,
    time_control: null,
    time_class: timeClass,
    opening_eco: null,
    opening_name: null,
    ply_count: game.movesUci.length,
    played_at: game.playedAt,
  };

  return { game: gameRow, positions, moves };
}

function normalizeFenKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

function hasFenMismatch(game: GameRecordInput): boolean {
  const board = new Chess();
  for (let i = 0; i < game.movesUci.length; i++) {
    if (normalizeFenKey(board.fen()) !== normalizeFenKey(game.fensBefore[i] ?? '')) return true;
    const uci = game.movesUci[i]!;
    try {
      const moved = board.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci[4] : undefined,
      });
      if (!moved) return false;
    } catch {
      return false;
    }
  }
  return false;
}

async function wakePollerIfRelevant(
  userId: string,
  platform: 'lichess' | 'chess.com',
  handleNormalized: string,
): Promise<boolean> {
  const sql = getPracticeDb();
  let hasRelevantReport = false;
  try {
    // Reset stale 'ready' (>1h old leaks_json) or 'failed' reports so the
    // poller picks them up again with the fresh corpus state.
    const rows = await sql<{ id: string }[]>`
      UPDATE prep_reports
      SET status = 'data_pending',
          error_text = NULL,
          leaks_json = NULL,
          completed_at = NULL
      WHERE requested_by = ${userId}::uuid
        AND target_platform = ${platform}
        AND target_handle_normalized = ${handleNormalized}
        AND (
          status = 'failed'
          OR (
            status = 'ready'
            AND leaks_json IS NOT NULL
            AND completed_at < NOW() - INTERVAL '1 hour'
          )
        )
      RETURNING id::text
    `;
    if (rows.length > 0) hasRelevantReport = true;
    if (!hasRelevantReport) {
      const existing = await sql<{ id: string }[]>`
        SELECT id::text FROM prep_reports
        WHERE requested_by = ${userId}::uuid
          AND target_platform = ${platform}
          AND target_handle_normalized = ${handleNormalized}
        LIMIT 1
      `;
      hasRelevantReport = existing.length > 0;
    }
  } catch (err) {
    console.error('[bulk-ingest] reset stale report failed:', err);
  }

  // Always fire the wake event — even when no report row exists yet, the
  // user will POST one shortly via the leaks panel, and the poller benefits
  // from running soon afterward.
  await sendEvent({ name: 'chessco/prepare-reports.poll.requested', data: {} });
  return hasRelevantReport;
}
