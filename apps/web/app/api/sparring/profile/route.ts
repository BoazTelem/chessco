/**
 * POST /api/sparring/profile — upsert the caller's sparring profile + fees.
 *
 * Body: {
 *   opted_in: boolean,
 *   bio?: string,
 *   away_until?: string|null,  // ISO 8601 or null to clear
 *   fees?: Array<{
 *     time_class: 'bullet'|'blitz'|'rapid'|'classical',
 *     fee_cents: number, currency?: string, funding_type?: 'cash'|'credits'|'either', active?: boolean
 *   }>
 * }
 *
 * The fees array, when present, fully replaces the caller's per-time-class
 * fee rows: existing rows for time classes not in the payload are marked
 * inactive, and each payload entry upserts its row.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUser } from '@/lib/auth';
import { getPracticeDb } from '@/lib/practice/db';

const Fee = z.object({
  time_class: z.enum(['bullet', 'blitz', 'rapid', 'classical']),
  fee_cents: z.number().int().min(0).max(50_000),
  currency: z.string().length(3).optional(),
  funding_type: z.enum(['cash', 'credits', 'either']).optional(),
  active: z.boolean().optional(),
});

const Input = z.object({
  opted_in: z.boolean(),
  bio: z.string().trim().max(140).nullable().optional(),
  away_until: z.string().datetime().nullable().optional(),
  fees: z.array(Fee).max(8).optional(),
});

export async function POST(req: Request): Promise<NextResponse> {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  let body: z.infer<typeof Input>;
  try {
    body = Input.parse(await req.json());
  } catch (err) {
    const msg =
      err instanceof z.ZodError ? (err.issues[0]?.message ?? 'invalid input') : 'invalid JSON';
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const sql = getPracticeDb();

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO player_sparring_profiles
        (profile_id, opted_in, bio, away_until)
      VALUES
        (${user.id}::uuid,
         ${body.opted_in},
         ${body.bio ?? null},
         ${body.away_until ?? null})
      ON CONFLICT (profile_id) DO UPDATE
        SET opted_in = EXCLUDED.opted_in,
            bio = EXCLUDED.bio,
            away_until = EXCLUDED.away_until,
            updated_at = NOW()
    `;

    if (body.fees) {
      // Deactivate any rows for time classes NOT in the payload.
      const payloadTimeClasses = body.fees.map((f) => f.time_class);
      if (payloadTimeClasses.length > 0) {
        await tx`
          UPDATE player_sparring_fees
             SET active = false, updated_at = NOW()
           WHERE profile_id = ${user.id}::uuid
             AND time_class NOT IN ${tx(payloadTimeClasses)}
        `;
      } else {
        await tx`
          UPDATE player_sparring_fees
             SET active = false, updated_at = NOW()
           WHERE profile_id = ${user.id}::uuid
        `;
      }
      // Upsert each fee row.
      for (const fee of body.fees) {
        await tx`
          INSERT INTO player_sparring_fees
            (profile_id, time_class, fee_cents, currency, funding_type, active)
          VALUES
            (${user.id}::uuid,
             ${fee.time_class},
             ${fee.fee_cents},
             ${fee.currency ?? 'USD'},
             ${fee.funding_type ?? 'either'},
             ${fee.active ?? true})
          ON CONFLICT (profile_id, time_class) DO UPDATE
            SET fee_cents = EXCLUDED.fee_cents,
                currency = EXCLUDED.currency,
                funding_type = EXCLUDED.funding_type,
                active = EXCLUDED.active,
                updated_at = NOW()
        `;
      }
    }
  });

  return NextResponse.json({ ok: true });
}
