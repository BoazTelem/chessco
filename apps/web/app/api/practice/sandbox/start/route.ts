/**
 * POST /api/practice/sandbox/start
 *
 * Create a new practice-bot game on the Maia ladder. Body:
 *   { bot_rating: 1500 | 1700 | 1900, time_class, time_control, mode }
 *
 * Auth required. The route:
 *   1. Looks up the caller's verified rating in the chosen time class.
 *   2. If mode='credit', enforces the rating-floor rule (bot_rating >=
 *      user_rating). Mismatch returns 400 with the discriminated reason
 *      so the UI can render a precise CTA.
 *   3. Resolves the maia_weights row for the chosen ladder bucket; refuses
 *      if no ready weights are seeded yet (means the inference service
 *      hasn't been deployed).
 *   4. Inserts a practice_bot_games row. The SQL CHECK constraint backstops
 *      step 2 — even if the route check were bypassed, a credit-mode insert
 *      with weaker bot would fail at the DB.
 *
 * Returns { game_id, weights_id, user_rating, bot_rating, mode }.
 *
 * Design rationale: docs/PRACTICE-CREDIT-MODE.md
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { getPracticeDb } from '@/lib/practice/db';
import {
  checkCreditEligibility,
  getUserVerifiedRating,
  resolveLadderWeightsId,
  type TimeClass,
  type GameMode,
} from '@/lib/practice/bot-game';

const LADDER_RATINGS = [1500, 1700, 1900] as const;

const Input = z.object({
  bot_rating: z.union([z.literal(1500), z.literal(1700), z.literal(1900)]),
  time_class: z.enum(['bullet', 'blitz', 'rapid', 'classical']),
  time_control: z
    .string()
    .trim()
    .regex(/^\d+\+\d+$|^\d+$/, 'time_control must be "M+I" or "M"'),
  mode: z.enum(['casual', 'credit']),
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

  // Belt-and-suspenders: TypeScript already constrains bot_rating to the
  // ladder set, but a stale client could ship 1300; reject explicitly.
  if (!LADDER_RATINGS.includes(body.bot_rating as (typeof LADDER_RATINGS)[number])) {
    return NextResponse.json({ error: 'unsupported_ladder_rating' }, { status: 400 });
  }

  const sql = getPracticeDb();

  const userRating = await getUserVerifiedRating(sql, user.id, body.time_class as TimeClass);

  if (body.mode === 'credit') {
    const eligibility = checkCreditEligibility(userRating, body.bot_rating);
    if (!eligibility.eligible) {
      return NextResponse.json(
        {
          error: 'credit_mode_unavailable',
          detail: eligibility,
        },
        { status: 400 },
      );
    }
  }

  // userRating is also persisted on the game row even in casual mode so we
  // can audit the rating-floor decision after the fact. Use 0 as a sentinel
  // when no verified rating exists (only possible in casual mode reaching
  // this point).
  const effectiveUserRating = userRating ?? 0;

  const weightsId = await resolveLadderWeightsId(sql, body.bot_rating);
  if (!weightsId) {
    return NextResponse.json(
      {
        error: 'ladder_not_seeded',
        message: `No ready maia_weights row found for maia-${body.bot_rating}. Seed the ladder rows in Supabase (see docs/MAIA-DEPLOYMENT.md Step 6).`,
      },
      { status: 503 },
    );
  }

  const rows = await sql<{ id: string }[]>`
    INSERT INTO practice_bot_games
      (profile_id, surface, bot_kind, bot_rating, user_rating, weights_id,
       time_class, time_control, mode)
    VALUES
      (${user.id}::uuid,
       'sandbox',
       'ladder',
       ${body.bot_rating},
       ${effectiveUserRating},
       ${weightsId}::uuid,
       ${body.time_class},
       ${body.time_control},
       ${body.mode as GameMode})
    RETURNING id::text
  `;
  const gameId = rows[0]?.id;
  if (!gameId) {
    return NextResponse.json({ error: 'insert_failed' }, { status: 500 });
  }

  return NextResponse.json({
    game_id: gameId,
    weights_id: weightsId,
    user_rating: userRating,
    bot_rating: body.bot_rating,
    mode: body.mode,
  });
}
