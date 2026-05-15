/**
 * POST /api/practice/settle — called by the realtime server when a game
 * ends. Under the credits-only pivot (migration 0039) new challenges are
 * always credit-funded, either free (credit_cost = 0) or paid at exactly
 * 1 credit per game (credit_cost = games_requested). Legacy cash and
 * legacy arbitrary-stake credit rows (created before the cutoff) still
 * settle through the old code paths so in-flight matches don't break.
 *
 *   Clean ending (checkmate, draw, resign, timeout, creator_abandoned):
 *     Legacy cash: D escrow / C opponent wallet (match_payout, USD)
 *     Paid credit: D creator credit_pending (challenge_consume)
 *                  + C opponent credit_available (practice_reward,
 *                    subject to daily / per-pair caps)
 *     Free credit: no ledger movement
 *     ratings.paid_games_completed++ for both participants
 *
 *   opponent_abandoned:
 *     Refund creator (cash or credit). No opponent reward.
 *     ratings.paid_games_abandoned++ for opponent.
 *
 *   aborted (game never started):
 *     Return escrow / reserved credit to creator. No rating change.
 *
 * Idempotent: matches.settled_at IS NOT NULL → return 200 ok without doing
 * anything.
 *
 * Authenticated by shared-secret header from the realtime app — NOT by
 * cookie. No user cookies on this path.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { grantPracticeReward } from '@/lib/credits';
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
               m.status, m.settled_at, c.creator_id, c.funding_type, c.credit_cost,
               c.games_requested
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
        funding_type: 'cash' | 'credits';
        credit_cost: number;
        games_requested: number;
      }>;
      const m = matchRows[0];
      if (!m) throw new HttpError(404, 'match not found');
      if (m.settled_at) return; // idempotent

      const txnId = crypto.randomUUID();
      // Under the credits-only pivot, paid credit games consume exactly 1
      // credit per settle call. Legacy rows (created before the pivot
      // cutoff) may have arbitrary credit_cost values but settle at 1/game
      // — close enough for in-flight stragglers in dev.
      const isPaidCreditGame = m.funding_type === 'credits' && m.credit_cost > 0;
      const creditPerGame = isPaidCreditGame ? 1 : 0;

      if (body.termination === 'opponent_abandoned') {
        // Refund the creator. Credit-funded games return the reserved credit.
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
        if (creditPerGame > 0) {
          await tx`
            UPDATE wallets
            SET credit_available = credit_available + ${creditPerGame},
                credit_pending = credit_pending - ${creditPerGame}
            WHERE profile_id = ${m.creator_id}
          `;
          await tx`
            INSERT INTO credit_ledger_entries (
              profile_id, direction, amount, category, reference_type, reference_id, metadata
            ) VALUES (
              ${m.creator_id}, 'C', ${creditPerGame}, 'challenge_refund', 'match', ${m.id},
              ${JSON.stringify({ termination: body.termination })}::jsonb
            )
          `;
        }
        await tx`
          UPDATE ratings SET paid_games_abandoned = paid_games_abandoned + 1
          WHERE profile_id = ${m.opponent_id}
        `;
      } else if (body.termination === 'aborted') {
        // No play happened. Return escrow or reserved credit to the creator.
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
        if (creditPerGame > 0) {
          await tx`
            UPDATE wallets
            SET credit_available = credit_available + ${creditPerGame},
                credit_pending = credit_pending - ${creditPerGame}
            WHERE profile_id = ${m.creator_id}
          `;
          await tx`
            INSERT INTO credit_ledger_entries (
              profile_id, direction, amount, category, reference_type, reference_id, metadata
            ) VALUES (
              ${m.creator_id}, 'C', ${creditPerGame}, 'challenge_refund', 'match', ${m.id},
              ${JSON.stringify({ termination: body.termination })}::jsonb
            )
          `;
        }
      } else {
        // Clean ending (including creator_abandoned): opponent gets paid.
        // Skip the cash ledger/wallet move for credit-funded practice games.
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
        if (creditPerGame > 0) {
          await tx`
            UPDATE wallets
            SET credit_pending = credit_pending - ${creditPerGame}
            WHERE profile_id = ${m.creator_id}
          `;
          await tx`
            INSERT INTO credit_ledger_entries (
              profile_id, direction, amount, category, reference_type, reference_id, metadata
            ) VALUES (
              ${m.creator_id}, 'D', ${creditPerGame}, 'challenge_consume', 'match', ${m.id},
              ${JSON.stringify({ termination: body.termination })}::jsonb
            )
          `;
          // Opponent earns 1 practice_reward credit (subject to abuse caps).
          // Rejection here doesn't fail the settlement — the match still
          // closes; the opponent just doesn't get the reward for this one.
          await grantPracticeReward(tx, {
            profileId: m.opponent_id,
            counterpartProfileId: m.creator_id,
            matchId: m.id,
          });
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
