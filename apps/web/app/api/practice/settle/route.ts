/**
 * POST /api/practice/settle — called by the realtime server when a game
 * ends. Runs the ledger settlement inside one transaction:
 *
 *   Clean ending (checkmate, draw, resign, timeout, creator_abandoned):
 *     D escrow / C opponent_user_wallet  category=match_payout
 *     opponent's wallet.available_cents += fee_cents
 *     matches.status = 'completed', settled_at = NOW()
 *     ratings.paid_games_completed++ for both participants
 *
 *   opponent_abandoned:
 *     D escrow / C creator_user_wallet  category=refund
 *     creator's wallet.available_cents += fee_cents
 *     matches.status = 'abandoned'
 *     ratings.paid_games_abandoned++ for opponent
 *     Also insert an auto-approved refund_requests row for the audit trail.
 *
 *   aborted (game never started):
 *     D escrow / C creator_user_wallet (no rating change)
 *
 * Idempotent: matches.settled_at IS NOT NULL → return 200 ok without doing
 * anything.
 *
 * Authenticated by shared-secret header from the realtime app — NOT by
 * cookie. No user cookies on this path.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getPracticeDb } from '@/lib/practice/db';

const Input = z.object({
  matchId: z.string().uuid(),
  result: z.enum(['1-0', '0-1', '1/2-1/2', '*']),
  termination: z.enum([
    'checkmate',
    'stalemate',
    'insufficient_material',
    'threefold_repetition',
    'fifty_moves',
    'resign',
    'timeout',
    'agreed_draw',
    'creator_abandoned',
    'opponent_abandoned',
    'aborted',
  ]),
});

export async function POST(req: Request): Promise<NextResponse> {
  const expected = process.env.PRACTICE_SETTLE_SECRET;
  const provided = req.headers.get('x-practice-settle-secret');
  if (!expected || provided !== expected) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  let body: z.infer<typeof Input>;
  try {
    body = Input.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  const sql = getPracticeDb();
  try {
    await sql.begin(async (tx) => {
      const matchRows = (await tx`
        SELECT m.id, m.challenge_id, m.opponent_id, m.fee_cents, m.opponent_payout_cents,
               m.status, m.settled_at, c.creator_id
        FROM matches m
        JOIN challenges c ON c.id = m.challenge_id
        WHERE m.id = ${body.matchId}
        FOR UPDATE
      `) as Array<{
        id: string;
        challenge_id: string;
        opponent_id: string;
        fee_cents: number;
        opponent_payout_cents: number;
        status: string;
        settled_at: string | null;
        creator_id: string;
      }>;
      const m = matchRows[0];
      if (!m) throw new HttpError(404, 'match not found');
      if (m.settled_at) return; // idempotent

      const txnId = crypto.randomUUID();

      if (body.termination === 'opponent_abandoned') {
        // Refund the creator (skip ledger ops when fee was 0 — free game).
        if (m.fee_cents > 0) {
          await tx`
            INSERT INTO ledger_entries (
              transaction_id, account_type, account_id, direction, amount_cents,
              currency, category, reference_type, reference_id
            ) VALUES
              (${txnId}, 'escrow', NULL, 'D', ${m.fee_cents}, 'USD', 'refund', 'match', ${m.id}),
              (${txnId}, 'user_wallet', ${m.creator_id}, 'C', ${m.fee_cents}, 'USD', 'refund', 'match', ${m.id})
          `;
          await tx`
            UPDATE wallets SET available_cents = available_cents + ${m.fee_cents}
            WHERE profile_id = ${m.creator_id}
          `;
          await tx`
            INSERT INTO refund_requests (
              match_id, requester_id, respondent_id, reason_code, status, amount_cents,
              auto_resolution_rule, resolved_at
            ) VALUES (
              ${m.id}, ${m.creator_id}, ${m.opponent_id}, 'opponent_abandoned',
              'auto_approved', ${m.fee_cents}, 'opponent_abandoned_auto_refund', NOW()
            )
          `;
        }
        await tx`
          UPDATE ratings SET paid_games_abandoned = paid_games_abandoned + 1
          WHERE profile_id = ${m.opponent_id}
        `;
      } else if (body.termination === 'aborted') {
        // No play happened. Return escrow to the creator (skip if free), no rating change.
        if (m.fee_cents > 0) {
          await tx`
            INSERT INTO ledger_entries (
              transaction_id, account_type, account_id, direction, amount_cents,
              currency, category, reference_type, reference_id
            ) VALUES
              (${txnId}, 'escrow', NULL, 'D', ${m.fee_cents}, 'USD', 'reversal', 'match', ${m.id}),
              (${txnId}, 'user_wallet', ${m.creator_id}, 'C', ${m.fee_cents}, 'USD', 'reversal', 'match', ${m.id})
          `;
          await tx`
            UPDATE wallets SET available_cents = available_cents + ${m.fee_cents}
            WHERE profile_id = ${m.creator_id}
          `;
        }
      } else {
        // Clean ending (including creator_abandoned): opponent gets paid.
        // Skip the ledger/wallet move when the game was free.
        if (m.opponent_payout_cents > 0) {
          await tx`
            INSERT INTO ledger_entries (
              transaction_id, account_type, account_id, direction, amount_cents,
              currency, category, reference_type, reference_id
            ) VALUES
              (${txnId}, 'escrow', NULL, 'D', ${m.opponent_payout_cents}, 'USD', 'match_payout', 'match', ${m.id}),
              (${txnId}, 'user_wallet', ${m.opponent_id}, 'C', ${m.opponent_payout_cents}, 'USD', 'match_payout', 'match', ${m.id})
          `;
          await tx`
            UPDATE wallets SET available_cents = available_cents + ${m.opponent_payout_cents}
            WHERE profile_id = ${m.opponent_id}
          `;
        }
        await tx`
          UPDATE ratings SET paid_games_completed = paid_games_completed + 1
          WHERE profile_id = ${m.creator_id}
        `;
        await tx`
          UPDATE ratings SET paid_games_completed = paid_games_completed + 1
          WHERE profile_id = ${m.opponent_id}
        `;
      }

      await tx`UPDATE matches SET settled_at = NOW() WHERE id = ${m.id}`;
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[practice/settle] error', err);
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
