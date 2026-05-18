/**
 * GET /api/prepare/games?platform=&handle=&since=&until=&limit=
 *
 * Phase 3 of the player-id pipeline — DB-first hydration for /prepare.
 * Returns whatever games we already have in the games corpus for the
 * given (platform, handle), so the OpeningTreeSection can render
 * immediately instead of waiting on a chess.com/lichess API fetch.
 *
 * Shape mirrors the client-side GameRecord (apps/web/lib/prepare/types.ts):
 * the browser merges the response straight into its in-memory store and
 * the live-fetch loop just pulls deltas (forward gap from the latest
 * cached game).
 *
 * Bounds: defaults to the last 12 months, capped at 1000 games. Prolific
 * handles past the cap fall back to the live fetch for older games. The
 * moves+positions JOIN is chunked at 500 game-ids to stay under Cloud
 * SQL's 10GB temp_file_limit (mirrors the worker fix in commit 6ef2d45).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getGamesDb } from '@/lib/games-db';
import type { GameResult, Platform, TimeClass } from '@/lib/prepare/types';

// 200 fits Vercel's 60s function ceiling for prolific chess.com handles:
// the games query is fast (~3s) but the moves+positions JOIN scales ~3ms
// per move via Nested Loop on positions_pkey, so 1000 games × ~80 moves
// chunked at 500 was hitting 30s+ on the JOIN alone. The client's
// live-fetch loop backfills any older games beyond this cap from the
// platform API, so prolific handles still get full data after hydration.
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;
const DEFAULT_WINDOW_DAYS = 365;
const MOVES_CHUNK = 500;

const Query = z.object({
  platform: z.enum(['lichess', 'chess.com']),
  handle: z.string().trim().min(1).max(128),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional(),
});

type DbTimeClass = 'bullet' | 'blitz' | 'rapid' | 'classical' | 'correspondence' | null;

interface GameRow {
  id: string;
  source_game_id: string;
  played_at: string;
  result: '1-0' | '0-1' | '1/2-1/2';
  time_class: DbTimeClass;
  white_handle: string | null;
  black_handle: string | null;
  white_rating: number | null;
  black_rating: number | null;
}

interface MoveRow {
  game_id: string;
  ply: number;
  san: string;
  uci: string;
  fen_before: string;
}

interface GameWire {
  id: string;
  playedAt: string;
  playerColor: 'white' | 'black';
  result: GameResult;
  resultText: '1-0' | '0-1' | '1/2-1/2';
  timeClass: TimeClass;
  whiteHandle: string;
  blackHandle: string;
  whiteElo: number | null;
  blackElo: number | null;
  movesSan: string[];
  movesUci: string[];
  fensBefore: string[];
}

function normalizeFenKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

function deriveResult(result: '1-0' | '0-1' | '1/2-1/2', color: 'white' | 'black'): GameResult {
  if (result === '1/2-1/2') return 'draw';
  if (result === '1-0') return color === 'white' ? 'win' : 'loss';
  return color === 'black' ? 'win' : 'loss';
}

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const parsed = Query.safeParse({
    platform: url.searchParams.get('platform'),
    handle: url.searchParams.get('handle'),
    since: url.searchParams.get('since') ?? undefined,
    until: url.searchParams.get('until') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_query' }, { status: 400 });
  }
  const { platform, handle } = parsed.data;
  const handleLower = handle.toLowerCase();
  const now = new Date();
  const since =
    parsed.data.since ?? new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const until = parsed.data.until ?? now;
  const limit = parsed.data.limit ?? DEFAULT_LIMIT;

  const sql = getGamesDb();

  let games: GameRow[];
  try {
    games = await sql<GameRow[]>`
      SELECT
        id::text,
        source_game_id,
        played_at::text,
        result,
        time_class,
        white_handle_snapshot AS white_handle,
        black_handle_snapshot AS black_handle,
        white_rating,
        black_rating
      FROM games
      WHERE source = ${platform satisfies Platform}
        AND played_at >= ${since}
        AND played_at <= ${until}
        AND (
          LOWER(white_handle_snapshot) = ${handleLower}
          OR LOWER(black_handle_snapshot) = ${handleLower}
        )
        AND length(pgn) > 0
        AND result IN ('1-0', '0-1', '1/2-1/2')
      ORDER BY played_at DESC
      LIMIT ${limit}
    `;
  } catch (err) {
    console.error('[prepare/games] games query failed:', err);
    return NextResponse.json({ error: 'db_query_failed' }, { status: 502 });
  }

  if (games.length === 0) {
    return NextResponse.json(
      { games: [], earliest: null, latest: null, hadMore: false },
      { status: 200 },
    );
  }

  const gameIds = games.map((g) => g.id);
  const movesByGame = new Map<string, MoveRow[]>();
  try {
    for (let i = 0; i < gameIds.length; i += MOVES_CHUNK) {
      const idChunk = gameIds.slice(i, i + MOVES_CHUNK);
      const chunk = await sql<MoveRow[]>`
        SELECT m.game_id::text, m.ply, m.san, m.uci, p.fen AS fen_before
        FROM moves m
        INNER JOIN positions p ON p.id = m.fen_before_id
        WHERE m.game_id = ANY(${idChunk}::uuid[])
        ORDER BY m.game_id, m.ply
      `;
      for (const m of chunk) {
        let arr = movesByGame.get(m.game_id);
        if (!arr) {
          arr = [];
          movesByGame.set(m.game_id, arr);
        }
        arr.push(m);
      }
    }
  } catch (err) {
    console.error('[prepare/games] moves query failed:', err);
    return NextResponse.json({ error: 'db_query_failed' }, { status: 502 });
  }

  const wire: GameWire[] = [];
  let earliest: string | null = null;
  let latest: string | null = null;

  for (const g of games) {
    const moves = movesByGame.get(g.id);
    if (!moves || moves.length === 0) continue;
    const playerColor: 'white' | 'black' =
      g.white_handle?.toLowerCase() === handleLower ? 'white' : 'black';
    const timeClass: TimeClass =
      g.time_class === null || g.time_class === 'correspondence' ? 'unknown' : g.time_class;

    wire.push({
      // Use the platform-native source_game_id so the client's de-dup
      // against live-fetched games (keyed on the same id) works cleanly.
      id: g.source_game_id,
      playedAt: g.played_at,
      playerColor,
      result: deriveResult(g.result, playerColor),
      resultText: g.result,
      timeClass,
      whiteHandle: g.white_handle ?? '',
      blackHandle: g.black_handle ?? '',
      whiteElo: g.white_rating,
      blackElo: g.black_rating,
      movesSan: moves.map((m) => m.san),
      movesUci: moves.map((m) => m.uci),
      fensBefore: moves.map((m) => normalizeFenKey(m.fen_before)),
    });

    if (!earliest || g.played_at < earliest) earliest = g.played_at;
    if (!latest || g.played_at > latest) latest = g.played_at;
  }

  return NextResponse.json(
    {
      games: wire,
      earliest,
      latest,
      hadMore: games.length >= limit,
    },
    {
      status: 200,
      headers: {
        // Short edge cache — repertoires don't change minute-to-minute,
        // but we still want crawl-write-backs to surface within a few
        // minutes on subsequent visits.
        'Cache-Control': 'private, max-age=60, stale-while-revalidate=300',
      },
    },
  );
}
