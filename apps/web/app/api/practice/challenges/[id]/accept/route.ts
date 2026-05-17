/**
 * POST /api/practice/challenges/[id]/accept — accept an open Practice
 * challenge. Creates a `matches` row + a `live_games` row, moves one game's
 * worth of escrow from the creator's pending_cents into the ledger, returns
 * the matchId so the client can route to /practice/g/[matchId].
 *
 * Auth required. Creator can't accept their own challenge. If the challenge
 * has games_completed + 1 == games_requested, it flips to status 'matched'
 * (no longer in lobby).
 *
 * Note on creator_color: 'w'/'b' fixes the creator's color; NULL = random.
 * Per the spec the deposit-side fee model means platform_fee_cents = 0 and
 * opponent_payout_cents = fee_cents.
 */
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getPracticeDb } from '@/lib/practice/db';
import { createNotification } from '@/lib/notifications';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, ctx: RouteContext): Promise<NextResponse> {
  const { id: challengeId } = await ctx.params;
  if (!/^[a-f0-9-]{36}$/i.test(challengeId)) {
    return NextResponse.json({ error: 'invalid challenge id' }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const sql = getPracticeDb();

  try {
    let invitationId: string | null = null;
    try {
      const body = (await req.json()) as { invitation_id?: unknown };
      if (typeof body.invitation_id === 'string' && /^[a-f0-9-]{36}$/i.test(body.invitation_id)) {
        invitationId = body.invitation_id;
      }
    } catch {
      // Empty/non-JSON body is fine; direct lobby accepts do not carry an invitation id.
    }

    const matchId = (await sql.begin(async (tx) => {
      // Block the user if they're banned. (is_banned is a SQL helper from 0022.)
      const banned = (await tx`SELECT is_banned(${user.id}) AS banned`) as Array<{
        banned: boolean;
      }>;
      if (banned[0]?.banned) throw new HttpError(403, 'account is suspended');

      // Lock the challenge row.
      const challenges = (await tx`
        SELECT id, creator_id, fen, creator_color, time_control, time_class, fee_cents,
               games_requested, games_completed, status, last_heartbeat, target_opponent_id
        FROM challenges
        WHERE id = ${challengeId}
        FOR UPDATE
      `) as Array<{
        id: string;
        creator_id: string;
        fen: string;
        creator_color: 'w' | 'b' | null;
        time_control: string;
        time_class: string;
        fee_cents: number;
        games_requested: number;
        games_completed: number;
        status: string;
        last_heartbeat: string;
        target_opponent_id: string | null;
      }>;
      const ch = challenges[0];
      if (!ch) throw new HttpError(404, 'challenge not found');
      if (ch.status !== 'open') throw new HttpError(409, 'challenge no longer open');
      if (ch.creator_id === user.id)
        throw new HttpError(400, "you can't accept your own challenge");
      // Direct invites are private to the named opponent.
      if (ch.target_opponent_id && ch.target_opponent_id !== user.id) {
        throw new HttpError(403, 'this invite is for a different player');
      }

      if (invitationId) {
        const invitationRows = (await tx`
          SELECT challenge_id::text, invitee_id::text, status, expires_at::text
          FROM challenge_invitations
          WHERE id = ${invitationId}::uuid
          FOR UPDATE
        `) as Array<{
          challenge_id: string;
          invitee_id: string;
          status: string;
          expires_at: string | null;
        }>;
        const inv = invitationRows[0];
        if (!inv) throw new HttpError(404, 'invitation not found');
        if (inv.challenge_id !== challengeId || inv.invitee_id !== user.id) {
          throw new HttpError(403, 'invitation does not belong to this challenge');
        }
        if (inv.status !== 'pending') throw new HttpError(409, 'invitation already resolved');
        if (inv.expires_at && new Date(inv.expires_at).getTime() <= Date.now()) {
          throw new HttpError(409, 'invitation expired');
        }
      }

      // Reject if the creator's heartbeat is stale — the lobby already
      // filters these out, but a race or a direct API call could still
      // land us here. Matches the lobby cutoff in /practice/page.tsx.
      const heartbeatAgeMs = Date.now() - new Date(ch.last_heartbeat).getTime();
      if (heartbeatAgeMs > 25_000) {
        throw new HttpError(409, 'creator is offline');
      }

      // Decide colors. NULL creator_color = random.
      const creatorColor: 'w' | 'b' = ch.creator_color ?? (Math.random() < 0.5 ? 'w' : 'b');
      const whiteUserId = creatorColor === 'w' ? ch.creator_id : user.id;
      const blackUserId = creatorColor === 'w' ? user.id : ch.creator_id;

      // Insert match. creator_id is denormalized from challenges so Realtime
      // can authorize delivery to the publisher without a cross-table join
      // (see migration 0030).
      const matchRows = (await tx`
        INSERT INTO matches (
          challenge_id, opponent_id, creator_id, fee_cents,
          platform_fee_cents, opponent_payout_cents, status
        ) VALUES (
          ${ch.id}, ${user.id}, ${ch.creator_id}, ${ch.fee_cents},
          0, ${ch.fee_cents}, 'accepted'
        )
        RETURNING id
      `) as Array<{ id: string }>;
      const match = matchRows[0];
      if (!match) throw new HttpError(500, 'match insert failed');

      // Insert live_game with the position from the challenge.
      const lgRows = (await tx`
        INSERT INTO live_games (
          match_id, white_user_id, black_user_id, initial_fen, current_fen,
          time_control, white_time_ms, black_time_ms, status
        ) VALUES (
          ${match.id}, ${whiteUserId}, ${blackUserId}, ${ch.fen}, ${ch.fen},
          ${ch.time_control},
          ${parseBaseMs(ch.time_control)}, ${parseBaseMs(ch.time_control)},
          'live'
        )
        RETURNING id
      `) as Array<{ id: string }>;
      const lg = lgRows[0];
      if (!lg) throw new HttpError(500, 'live_game insert failed');

      // Link match → live_game.
      await tx`UPDATE matches SET game_id = ${lg.id} WHERE id = ${match.id}`;

      // Escrow this game's fee: D creator user_wallet, C escrow.
      // Skip when fee_cents = 0 (credit-funded practice) because the cash
      // ledger has CHECK (amount_cents > 0).
      if (ch.fee_cents > 0) {
        const txnId = crypto.randomUUID();
        await tx`
          INSERT INTO ledger_entries (
            transaction_id, account_type, account_id, direction, amount_cents,
            currency, category, reference_type, reference_id
          ) VALUES
            (${txnId}, 'user_wallet', ${ch.creator_id}, 'D', ${ch.fee_cents}, 'USD', 'match_escrow', 'match', ${match.id}),
            (${txnId}, 'escrow', NULL, 'C', ${ch.fee_cents}, 'USD', 'match_escrow', 'match', ${match.id})
        `;
        // Move money off the creator's reserved bucket; available_cents
        // already debited at challenge-create time, so just pending_cents--.
        await tx`
          UPDATE wallets
          SET pending_cents = pending_cents - ${ch.fee_cents}
          WHERE profile_id = ${ch.creator_id}
        `;
      }

      // Decide whether the challenge stays open for more games or closes.
      const newCompleted = ch.games_completed + 1;
      if (newCompleted >= ch.games_requested) {
        await tx`UPDATE challenges SET status = 'matched', games_completed = ${newCompleted} WHERE id = ${ch.id}`;
      } else {
        await tx`UPDATE challenges SET games_completed = ${newCompleted} WHERE id = ${ch.id}`;
      }

      const acceptedInvitations = (await tx`
        UPDATE challenge_invitations
        SET status = 'accepted', responded_at = NOW()
        WHERE challenge_id = ${ch.id}
          AND invitee_id = ${user.id}
          AND status = 'pending'
        RETURNING id::text
      `) as Array<{ id: string }>;

      if (acceptedInvitations.length > 0) {
        await createNotification(
          {
            profileId: ch.creator_id,
            type: 'invitation.accepted',
            category: 'social',
            title: 'Your sparring invitation was accepted',
            body: 'Open the live game.',
            data: {
              challenge_id: ch.id,
              invitation_id: acceptedInvitations[0]!.id,
              invitee_id: user.id,
              match_id: match.id,
            },
            actionUrl: `/practice/g/${match.id}`,
          },
          tx,
        );
      }

      return match.id;
    })) as string;

    return NextResponse.json({ matchId });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[challenges/accept] error', err);
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }
}

function parseBaseMs(tc: string): number {
  const m = /^(\d+)\+\d+$/.exec(tc);
  return m ? Number(m[1]) * 60_000 : 5 * 60_000;
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
