/**
 * POST /api/practice/sandbox/end
 *
 * Settle a finished practice-bot game. Body:
 *   { game_id, result, result_reason, pgn }
 *
 * Settlement is one Postgres transaction (see lib/practice/bot-game.ts
 * `settleBotGame`):
 *   1. Update practice_bot_games.result + result_reason + ended_at + pgn.
 *   2. If mode='credit' and result moves credits, update the wallet and insert
 *      a single-sided credit_ledger_entries row (direction='C'/'D', amount=1).
 *
 * Credit deltas (matches docs/PRACTICE-CREDIT-MODE.md):
 *   user_win  -> +1, user_loss -> -1, abandoned -> -1, draw -> 0.
 *
 * Idempotent: a replay against an already-ended game returns 409. The
 * underlying UPDATE has `WHERE ended_at IS NULL` so a race between two
 * end-game POSTs only settles once.
 *
 * Trust model: the client reports the result. The route trusts the report;
 * the daily cap + audit log are the abuse mitigation, not server-side
 * replay validation (see docs/PRACTICE-CREDIT-MODE.md "Trust model").
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { getPracticeDb } from '@/lib/practice/db';
import { settleBotGame } from '@/lib/practice/bot-game';

const Input = z.object({
  game_id: z.string().uuid(),
  result: z.enum(['user_win', 'user_loss', 'draw', 'abandoned']),
  result_reason: z
    .enum([
      'checkmate',
      'resign',
      'timeout',
      'stalemate',
      '50_move',
      'threefold',
      'insufficient_material',
      'disconnect',
      'agreement',
    ])
    .or(z.string().trim().min(1).max(50)), // accept enum first, otherwise allow free-form for forward-compat
  pgn: z.string().trim().min(1).max(50_000),
});

export async function POST(req: Request): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  let body: z.infer<typeof Input>;
  try {
    body = Input.parse(await req.json());
  } catch (err) {
    const msg =
      err instanceof z.ZodError ? (err.issues[0]?.message ?? 'invalid input') : 'invalid JSON';
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const sql = getPracticeDb();

  try {
    const { creditDelta } = await settleBotGame(sql, {
      gameId: body.game_id,
      profileId: user.id,
      result: body.result,
      resultReason: body.result_reason,
      pgn: body.pgn,
    });
    return NextResponse.json({
      ok: true,
      credit_delta: creditDelta,
      result: body.result,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'game_not_found_or_already_ended') {
      return NextResponse.json({ error: msg }, { status: 409 });
    }
    if (msg === 'insufficient_credits') {
      return NextResponse.json({ error: msg }, { status: 402 });
    }
    return NextResponse.json({ error: 'settle_failed', detail: msg }, { status: 500 });
  }
}
