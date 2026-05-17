/**
 * POST /api/practice/sandbox/move
 *
 * Thin proxy from the sandbox UI to the Maia inference service. Body:
 *   { game_id, fen, history?: [{ uci, timeMs }] }
 *
 * The route validates that the game belongs to the caller and is still
 * live, then calls the Maia worker with the game's weights_id and the
 * caller's position. Returns the bot's move.
 *
 * Maia worker outcomes are surfaced as discriminated responses so the
 * client can render the right UX:
 *   - 200 with body         -> bot moved
 *   - 503 transport_unconfigured -> MAIA_INFERENCE_URL not set (deploy step pending)
 *   - 503 weights_not_ready -> Phase B per-opponent training in progress
 *   - 502 transport_error   -> Cloud Run hiccup; client should retry
 *
 * The server is stateless between moves in v0; the client is the source of
 * truth for game state (FEN + history). See docs/PRACTICE-CREDIT-MODE.md
 * "Trust model" — daily caps and audit logs are the abuse mitigation, not
 * server-side replay.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { getPracticeDb } from '@/lib/practice/db';
import { getBotMove } from '@/lib/maia/inference';

const Input = z.object({
  game_id: z.string().uuid(),
  fen: z.string().trim().min(15).max(120),
  history: z
    .array(
      z.object({
        uci: z
          .string()
          .trim()
          .regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/, 'invalid uci'),
        timeMs: z.number().int().nonnegative().optional(),
      }),
    )
    .max(2_000) // ~1000 moves; chess games never get there
    .optional(),
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

  const rows = await sql<{ weights_id: string; ended_at: string | null }[]>`
    SELECT weights_id::text, ended_at::text
    FROM practice_bot_games
    WHERE id = ${body.game_id}::uuid
      AND profile_id = ${user.id}::uuid
  `;
  const game = rows[0];
  if (!game) return NextResponse.json({ error: 'game_not_found' }, { status: 404 });
  if (game.ended_at) {
    return NextResponse.json({ error: 'game_already_ended' }, { status: 409 });
  }

  const outcome = await getBotMove({
    weightsId: game.weights_id,
    fen: body.fen,
    history: body.history?.map((h) => ({ uci: h.uci, timeMs: h.timeMs ?? 0 })),
  });

  switch (outcome.kind) {
    case 'ok':
      return NextResponse.json({
        uci: outcome.move.uci,
        san: outcome.move.san,
        probability: outcome.move.probability,
        latency_ms: outcome.move.latencyMs,
      });
    case 'transport_unconfigured':
      return NextResponse.json(
        { error: 'inference_unconfigured', message: outcome.message },
        { status: 503 },
      );
    case 'weights_not_ready':
      return NextResponse.json(
        { error: 'weights_not_ready', status: outcome.status },
        { status: 503 },
      );
    case 'transport_error':
      return NextResponse.json(
        { error: 'inference_error', message: outcome.message },
        { status: 502 },
      );
  }
}
