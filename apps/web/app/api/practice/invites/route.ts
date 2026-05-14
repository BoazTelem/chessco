/**
 * POST /api/practice/invites — create a direct Practice invite from one online
 * user to another. Unlike public lobby challenges this:
 *   - costs 1 publishing credit and reserves it until the game settles/cancels
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
const DIRECT_INVITE_CREDIT_COST = 1;

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
    const result = (await sql.begin(async (tx) => {
      const wallets = (await tx`
        SELECT credit_available FROM wallets WHERE profile_id = ${user.id} FOR UPDATE
      `) as Array<{ credit_available: number }>;
      const wallet = wallets[0];
      if (!wallet) throw new HttpError(400, 'no wallet on file');
      if (wallet.credit_available < DIRECT_INVITE_CREDIT_COST) {
        throw new HttpError(402, 'Direct invites require 1 credit.');
      }

      await tx`
        UPDATE wallets
        SET credit_available = credit_available - ${DIRECT_INVITE_CREDIT_COST},
            credit_pending = credit_pending + ${DIRECT_INVITE_CREDIT_COST}
        WHERE profile_id = ${user.id}
      `;

      const inserted = (await tx`
        INSERT INTO challenges (
          creator_id, fen, creator_color, time_control, time_class,
          fee_cents, currency, games_requested, opening_name, eco_code,
          target_opponent_id, funding_type, credit_cost
        ) VALUES (
          ${user.id}, ${fenCheck.fen}, ${parsed.creatorColor ?? null},
          ${parsed.timeControl}, ${parsed.timeClass},
          0, 'USD', 1, ${detected?.name ?? null}, ${detected?.ecoCode ?? null},
          ${parsed.targetUserId}, 'credits', ${DIRECT_INVITE_CREDIT_COST}
        )
        RETURNING id
      `) as Array<{ id: string }>;
      const row = inserted[0];
      if (!row) throw new HttpError(500, 'insert failed');

      await tx`
        INSERT INTO credit_ledger_entries (
          profile_id, direction, amount, category, reference_type, reference_id, metadata
        ) VALUES (
          ${user.id}, 'D', ${DIRECT_INVITE_CREDIT_COST}, 'challenge_reserve', 'challenge', ${row.id},
          ${JSON.stringify({
            direct_invite: true,
            games_requested: 1,
            target_opponent_id: parsed.targetUserId,
          })}::jsonb
        )
      `;

      return row.id;
    })) as string;

    return NextResponse.json({ id: result });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[invites:POST] error', err);
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
