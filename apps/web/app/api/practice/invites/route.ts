/**
 * POST /api/practice/invites — create a direct, free Practice invite from one
 * online user to another. Unlike public lobby challenges this:
 *   - skips the wallet reserve / escrow path (fee_cents = 0)
 *   - sets challenges.target_opponent_id so only the invited user can accept
 *   - hides the row from the public lobby query
 *
 * Body: { targetUserId, fen, timeControl, timeClass }.
 * Returns: { id } on success.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { getPracticeDb } from '@/lib/practice/db';
import { validateFen } from '@/lib/practice/fen';
import { detectOpening } from '@/lib/practice/openings';

const TIME_CONTROL_RE = /^\d+\+\d+$/;
const TIME_CLASS = ['bullet', 'blitz', 'rapid', 'classical'] as const;

const Input = z.object({
  targetUserId: z.string().uuid(),
  fen: z.string().min(10).max(120),
  creatorColor: z.enum(['w', 'b']).nullable().optional(),
  timeControl: z.string().regex(TIME_CONTROL_RE, 'time_control must look like "5+0"'),
  timeClass: z.enum(TIME_CLASS),
});

export async function POST(req: Request): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  let parsed: z.infer<typeof Input>;
  try {
    parsed = Input.parse(await req.json());
  } catch (err) {
    const msg =
      err instanceof z.ZodError ? (err.issues[0]?.message ?? 'invalid input') : 'invalid JSON';
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  if (parsed.targetUserId === user.id) {
    return NextResponse.json({ error: "you can't invite yourself" }, { status: 400 });
  }

  const fenCheck = validateFen(parsed.fen);
  if (!fenCheck.ok) {
    return NextResponse.json({ error: `position invalid: ${fenCheck.reason}` }, { status: 400 });
  }

  const detected = detectOpening(fenCheck.fen);
  const sql = getPracticeDb();

  try {
    const inserted = (await sql`
      INSERT INTO challenges (
        creator_id, fen, creator_color, time_control, time_class,
        fee_cents, currency, games_requested, opening_name, eco_code,
        target_opponent_id
      ) VALUES (
        ${user.id}, ${fenCheck.fen}, ${parsed.creatorColor ?? null},
        ${parsed.timeControl}, ${parsed.timeClass},
        0, 'USD', 1, ${detected?.name ?? null}, ${detected?.ecoCode ?? null},
        ${parsed.targetUserId}
      )
      RETURNING id
    `) as Array<{ id: string }>;
    const row = inserted[0];
    if (!row) return NextResponse.json({ error: 'insert failed' }, { status: 500 });
    return NextResponse.json({ id: row.id });
  } catch (err) {
    console.error('[invites:POST] error', err);
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }
}
