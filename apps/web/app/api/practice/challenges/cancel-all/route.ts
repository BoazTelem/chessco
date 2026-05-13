/**
 * POST /api/practice/challenges/cancel-all — fast-path challenge cancellation
 * fired by the publisher's browser on `pagehide` (sendBeacon). Refunds the
 * reserved pending_cents back to available_cents for every open challenge the
 * caller owns and flips them to status='cancelled'.
 *
 * Why a beacon instead of relying on the heartbeat timeout alone: clean tab
 * closes happen often, and we'd rather free the lobby slot (and the deposit)
 * immediately than wait 45 s. Crashes / force-kills still fall through to the
 * heartbeat path — that's why the lobby filters by last_heartbeat too.
 */
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getPracticeDb } from '@/lib/practice/db';

export async function POST(): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const sql = getPracticeDb();
  try {
    const cancelled = (await sql.begin(async (tx) => {
      const rows = (await tx`
        SELECT id, fee_cents, games_requested, games_completed
        FROM challenges
        WHERE creator_id = ${user.id} AND status = 'open'
        FOR UPDATE
      `) as Array<{
        id: string;
        fee_cents: number;
        games_requested: number;
        games_completed: number;
      }>;
      if (rows.length === 0) return 0;

      // Refund the unmatched-games portion of each challenge's reservation.
      let refund = 0;
      for (const r of rows) {
        const remaining = r.games_requested - r.games_completed;
        if (remaining > 0) refund += r.fee_cents * remaining;
      }
      if (refund > 0) {
        await tx`
          UPDATE wallets
          SET available_cents = available_cents + ${refund},
              pending_cents = pending_cents - ${refund}
          WHERE profile_id = ${user.id}
        `;
      }

      await tx`
        UPDATE challenges SET status = 'cancelled'
        WHERE creator_id = ${user.id} AND status = 'open'
      `;
      return rows.length;
    })) as number;

    return NextResponse.json({ cancelled });
  } catch (err) {
    console.error('[challenges/cancel-all] error', err);
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }
}
