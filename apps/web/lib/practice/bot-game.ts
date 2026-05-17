/**
 * Practice-bot game helpers.
 *
 * Design rationale: docs/PRACTICE-CREDIT-MODE.md
 * HTTP contract: docs/MAIA-INFERENCE.md
 *
 * Three concerns:
 *   1. Verified-rating lookup — what's the user's strongest verified rating
 *      in a given time class? Returns null when the user has no linked
 *      account with a rating in that bucket (which disqualifies credit mode).
 *   2. Credit-mode availability gate — applied at /start (route layer) AND
 *      at the DB layer (CHECK constraint on practice_bot_games).
 *   3. Settlement — atomic transaction that updates the game row + writes
 *      the credit_ledger_entries delta when mode='credit' and the result
 *      requires it.
 */

import type { Sql, TransactionSql } from 'postgres';

export type TimeClass = 'bullet' | 'blitz' | 'rapid' | 'classical';
export type GameMode = 'casual' | 'credit';
export type GameResult = 'user_win' | 'user_loss' | 'draw' | 'abandoned';
export type Surface = 'sandbox' | 'otb';
export type BotKind = 'ladder' | 'opponent_individual';

type SqlLike = Sql<Record<string, never>> | TransactionSql<Record<string, never>>;

/**
 * Look up the user's strongest verified rating in the given time class.
 *
 * Sources, in priority order:
 *   1. `external_accounts` rows where `verified = true` (lichess + chess.com).
 *      Per the spec: prefer chess.com > lichess for bullet/blitz/rapid, prefer
 *      lichess for classical (chess.com doesn't have classical, only daily
 *      correspondence — which we don't expose as a practice time class).
 *   2. `federation_players` (FIDE etc.) via `players.profile_id` -> `players.id`
 *      -> `federation_players.player_id`. classical uses FIDE standard;
 *      rapid/blitz use FIDE rapid/blitz respectively; bullet has no FIDE
 *      equivalent.
 *
 * For v0 we collapse these into a single `MAX(rating)` across all sources —
 * the user's strongest verified rating in that time class is what we gate
 * credit-mode on. That's slightly stricter than priority-ordering: a 1700
 * chess.com blitz player with a stale 1500 lichess rating still gets 1700
 * as their floor, which is the anti-sandbag-friendly direction.
 *
 * Returns null if the user has no verified rating in the chosen time class.
 * The /start route turns null into "credit mode not available; link a
 * chess.com or lichess account" UX.
 */
export async function getUserVerifiedRating(
  sql: SqlLike,
  profileId: string,
  timeClass: TimeClass,
): Promise<number | null> {
  // external_accounts column name per the time class.
  const externalColumn = (
    {
      bullet: 'rating_bullet',
      blitz: 'rating_blitz',
      rapid: 'rating_rapid',
      classical: 'rating_classical',
    } as const
  )[timeClass];

  // federation_players column. No bullet at federations.
  const federationColumn = (
    {
      bullet: null,
      blitz: 'rating_blitz',
      rapid: 'rating_rapid',
      classical: 'rating_standard',
    } as const
  )[timeClass];

  // External-accounts rating. Filter to verified = true so an unverified
  // claim (someone typed a handle but didn't confirm via the OAuth /
  // bio-token flow) can't grease credit-mode access.
  const externalRows = await sql<{ r: number | null }[]>`
    SELECT MAX(${sql(externalColumn)})::int AS r
    FROM external_accounts
    WHERE profile_id = ${profileId}::uuid
      AND verified = true
      AND ${sql(externalColumn)} IS NOT NULL
  `;
  const external = externalRows[0]?.r ?? null;

  let federation: number | null = null;
  if (federationColumn) {
    const federationRows = await sql<{ r: number | null }[]>`
      SELECT MAX(fp.${sql(federationColumn)})::int AS r
      FROM federation_players fp
      INNER JOIN players p ON p.id = fp.player_id
      WHERE p.profile_id = ${profileId}::uuid
        AND fp.${sql(federationColumn)} IS NOT NULL
    `;
    federation = federationRows[0]?.r ?? null;
  }

  if (external === null && federation === null) return null;
  return Math.max(external ?? 0, federation ?? 0);
}

/**
 * Credit mode is available iff the user has a verified rating AND the bot
 * rating is at or above it. Mirrors the SQL CHECK constraint on
 * practice_bot_games (`mode = 'casual' OR bot_rating >= user_rating`).
 *
 * Returns a discriminated union so route callers can surface the exact
 * reason in the UI.
 */
export type CreditEligibility =
  | { eligible: true; userRating: number }
  | { eligible: false; reason: 'no_verified_rating' }
  | { eligible: false; reason: 'bot_below_user'; userRating: number; botRating: number };

export function checkCreditEligibility(
  userRating: number | null,
  botRating: number,
): CreditEligibility {
  if (userRating === null) {
    return { eligible: false, reason: 'no_verified_rating' };
  }
  if (botRating < userRating) {
    return { eligible: false, reason: 'bot_below_user', userRating, botRating };
  }
  return { eligible: true, userRating };
}

/**
 * Resolve the most recent ready Maia weights row for a ladder bucket.
 * Phase A only has three rows (1500/1700/1900) seeded with fixed UUIDs;
 * picking by `base_model = 'maia-<rating>' AND status = 'ready'` survives
 * a future re-seed where UUIDs change without breaking the routes.
 */
export async function resolveLadderWeightsId(
  sql: SqlLike,
  ladderRating: number,
): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    SELECT id::text
    FROM maia_weights
    WHERE base_model = ${`maia-${ladderRating}`}
      AND status = 'ready'
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

/**
 * Settle a finished bot game in one transaction:
 *   1. Update practice_bot_games with result + ended_at + (final) pgn.
 *   2. If mode='credit' and the result moves credits, update the wallet and
 *      insert a single-sided credit_ledger_entries row.
 *
 * Credit delta rules (matches docs/PRACTICE-CREDIT-MODE.md):
 *   user_win  -> +1 credit  (direction='C', category='practice_bot_win')
 *   user_loss -> -1 credit  (direction='D', category='practice_bot_loss')
 *   draw      ->  0 credits (no ledger row written)
 *   abandoned -> -1 credit  (treated as a loss for credit settlement)
 *
 * Returns the credit delta applied (positive, zero, or negative) so the
 * caller can echo it back to the client.
 */
export async function settleBotGame(
  sql: Sql<Record<string, never>>,
  args: {
    gameId: string;
    profileId: string;
    result: GameResult;
    resultReason: string;
    pgn: string;
  },
): Promise<{ creditDelta: number }> {
  return sql.begin(async (tx) => {
    const updated = await tx<{ mode: GameMode; ended_at: string | null }[]>`
      UPDATE practice_bot_games
      SET result = ${args.result},
          result_reason = ${args.resultReason},
          pgn = ${args.pgn},
          ended_at = NOW()
      WHERE id = ${args.gameId}::uuid
        AND profile_id = ${args.profileId}::uuid
        AND ended_at IS NULL
      RETURNING mode, ended_at::text
    `;
    if (updated.length === 0) {
      throw new Error('game_not_found_or_already_ended');
    }
    const row = updated[0]!;
    if (row.mode === 'casual') return { creditDelta: 0 };

    const ledgerEffect: { direction: 'C' | 'D'; category: string; delta: number } | null = (() => {
      switch (args.result) {
        case 'user_win':
          return { direction: 'C', category: 'practice_bot_win', delta: 1 };
        case 'user_loss':
        case 'abandoned':
          return { direction: 'D', category: 'practice_bot_loss', delta: -1 };
        case 'draw':
          return null;
      }
    })();
    if (!ledgerEffect) {
      await tx`
        INSERT INTO audit_logs (actor_type, actor_id, action, target_type, target_id, after)
        VALUES (
          'system',
          ${args.profileId}::uuid,
          'practice_bot.settle',
          'practice_bot_game',
          ${args.gameId},
          ${JSON.stringify({
            result: args.result,
            result_reason: args.resultReason,
            credit_delta: 0,
          })}::jsonb
        )
      `;
      return { creditDelta: 0 };
    }

    await tx`
      INSERT INTO wallets (profile_id)
      VALUES (${args.profileId}::uuid)
      ON CONFLICT (profile_id) DO NOTHING
    `;

    if (ledgerEffect.direction === 'D') {
      const debited = await tx<{ credit_available: number }[]>`
        UPDATE wallets
        SET credit_available = credit_available - 1,
            updated_at = NOW()
        WHERE profile_id = ${args.profileId}::uuid
          AND credit_available >= 1
        RETURNING credit_available
      `;
      if (debited.length === 0) {
        throw new Error('insufficient_credits');
      }
    } else {
      await tx`
        UPDATE wallets
        SET credit_available = credit_available + 1,
            updated_at = NOW()
        WHERE profile_id = ${args.profileId}::uuid
      `;
    }

    await tx`
      INSERT INTO credit_ledger_entries
        (profile_id, direction, amount, category, reference_type, reference_id, metadata)
      VALUES (
        ${args.profileId}::uuid,
        ${ledgerEffect.direction},
        1,
        ${ledgerEffect.category},
        'practice_bot_game',
        ${args.gameId},
        ${JSON.stringify({
          result: args.result,
          result_reason: args.resultReason,
        })}::jsonb
      )
    `;

    await tx`
      INSERT INTO audit_logs (actor_type, actor_id, action, target_type, target_id, after)
      VALUES (
        'system',
        ${args.profileId}::uuid,
        'practice_bot.settle',
        'practice_bot_game',
        ${args.gameId},
        ${JSON.stringify({
          result: args.result,
          result_reason: args.resultReason,
          credit_delta: ledgerEffect.delta,
        })}::jsonb
      )
    `;
    return { creditDelta: ledgerEffect.delta };
  });
}
