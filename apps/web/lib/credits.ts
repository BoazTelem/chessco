import type { TransactionSql } from 'postgres';
import { getPracticeDb } from '@/lib/practice/db';
import { appOrigin, createNotification, sendNotificationEmail } from '@/lib/notifications';

const LINK_BONUS_AMOUNT = 5;
const LINK_BONUS_CAP = 10;
const LINK_BONUS_PLATFORMS = new Set(['lichess', 'chess.com']);

export const REFERRAL_BONUS_AMOUNT = 20;
export const REFERRAL_BONUS_CAP = 100;

export const PRACTICE_REWARD_AMOUNT = 1;
// Caps prevent the slow-burn collusion vector where two accounts trade
// practice wins to launder expiring subscription credits into non-expiring
// practice_reward credits.
export const PRACTICE_REWARD_DAILY_CAP = 30;
export const PRACTICE_REWARD_PAIR_CAP_PER_WEEK = 30;

export type PracticeRewardReason = 'ok' | 'daily_cap' | 'pair_cap' | 'already_granted';

/**
 * Grant 1 practice_reward credit to the opponent of a completed paid practice
 * game. Must be called inside the settle route's existing transaction so the
 * reward is atomic with the match settlement.
 *
 * Concurrency: takes an advisory transaction lock keyed on the recipient's
 * profile id BEFORE reading the cap totals, so two settlements completing
 * simultaneously for the same helper serialise here instead of both passing
 * a stale cap check.
 *
 * Idempotency: credit_grants has UNIQUE(profile_id, source_type, source_id).
 * source_id = matchId means each match can produce at most one reward grant
 * per profile. We gate the wallet/ledger writes on the INSERT actually
 * inserting (RETURNING) so a re-settle of the same match cannot double-credit.
 */
export async function grantPracticeReward(
  tx: TransactionSql<Record<string, never>>,
  args: { profileId: string; counterpartProfileId: string; matchId: string },
): Promise<{ granted: number; reason: PracticeRewardReason }> {
  const { profileId, counterpartProfileId, matchId } = args;

  // Serialise cap checks for this helper. Matches the pattern used by
  // grantLinkCredits / grantReferralCredits above.
  await tx`SELECT pg_advisory_xact_lock(hashtext(${profileId})::bigint)`;

  const dailyRows = (await tx`
    SELECT COALESCE(SUM(amount), 0)::int AS total
    FROM credit_ledger_entries
    WHERE profile_id = ${profileId}
      AND category = 'practice_reward'
      AND created_at >= NOW() - INTERVAL '24 hours'
  `) as Array<{ total: number }>;
  const dailyTotal = Number(dailyRows[0]?.total ?? 0);
  if (dailyTotal + PRACTICE_REWARD_AMOUNT > PRACTICE_REWARD_DAILY_CAP) {
    return { granted: 0, reason: 'daily_cap' };
  }

  const pairRows = (await tx`
    SELECT COALESCE(SUM(amount), 0)::int AS total
    FROM credit_ledger_entries
    WHERE profile_id = ${profileId}
      AND counterpart_profile_id = ${counterpartProfileId}
      AND category = 'practice_reward'
      AND created_at >= NOW() - INTERVAL '7 days'
  `) as Array<{ total: number }>;
  const pairTotal = Number(pairRows[0]?.total ?? 0);
  if (pairTotal + PRACTICE_REWARD_AMOUNT > PRACTICE_REWARD_PAIR_CAP_PER_WEEK) {
    return { granted: 0, reason: 'pair_cap' };
  }

  // Insert the grant and only proceed with the wallet/ledger writes if the
  // insert actually happened. If a prior settlement of the same match
  // already created the grant, RETURNING is empty and we exit early instead
  // of double-crediting.
  const inserted = (await tx`
    INSERT INTO credit_grants (
      profile_id, source_type, source_id, amount, metadata
    ) VALUES (
      ${profileId}, 'practice_reward', ${matchId}, ${PRACTICE_REWARD_AMOUNT},
      ${JSON.stringify({ counterpart_profile_id: counterpartProfileId })}::jsonb
    )
    ON CONFLICT (profile_id, source_type, source_id) DO NOTHING
    RETURNING id
  `) as Array<{ id: string }>;
  if (inserted.length === 0) {
    return { granted: 0, reason: 'already_granted' };
  }

  await tx`
    INSERT INTO wallets (profile_id) VALUES (${profileId})
    ON CONFLICT (profile_id) DO NOTHING
  `;

  await tx`
    UPDATE wallets
    SET credit_available = credit_available + ${PRACTICE_REWARD_AMOUNT}
    WHERE profile_id = ${profileId}
  `;

  await tx`
    INSERT INTO credit_ledger_entries (
      profile_id, direction, amount, category,
      reference_type, reference_id, counterpart_profile_id, metadata
    ) VALUES (
      ${profileId}, 'C', ${PRACTICE_REWARD_AMOUNT}, 'practice_reward',
      'match', ${matchId}, ${counterpartProfileId}, NULL
    )
  `;

  // Dedupe per (profile, counterpart, day) so a player who wins 12 games
  // against the same opponent in one day gets one notification row with
  // data.amount = 12, not 12 separate rows.
  const dayKey = new Date().toISOString().slice(0, 10);
  await createNotification(
    {
      profileId,
      type: 'credit.practice_reward_earned',
      category: 'credits',
      title: 'You earned a practice credit',
      body: `+${PRACTICE_REWARD_AMOUNT} credit for a paid practice win.`,
      data: { amount: PRACTICE_REWARD_AMOUNT, match_id: matchId, day: dayKey },
      actionUrl: '/account/wallet',
      dedupeKey: `practice_reward:${counterpartProfileId}:${dayKey}`,
    },
    tx,
  );

  return { granted: PRACTICE_REWARD_AMOUNT, reason: 'ok' };
}

export async function grantLinkCredits(
  profileId: string,
  platform: string,
  externalId: string,
): Promise<{ granted: number }> {
  if (!LINK_BONUS_PLATFORMS.has(platform)) return { granted: 0 };

  const normalizedExternalId = externalId.trim().toLowerCase();
  if (!normalizedExternalId) return { granted: 0 };

  const sourceId = `${platform}:${normalizedExternalId}`;
  const sql = getPracticeDb();

  const granted = (await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${profileId})::bigint)`;

    const existing = (await tx`
      SELECT id FROM credit_grants
      WHERE profile_id = ${profileId}
        AND source_type = 'external_account_link'
        AND source_id = ${sourceId}
      LIMIT 1
    `) as Array<{ id: string }>;
    if (existing.length > 0) return 0;

    const totals = (await tx`
      SELECT COALESCE(SUM(amount), 0)::int AS total
      FROM credit_grants
      WHERE profile_id = ${profileId}
        AND source_type = 'external_account_link'
    `) as Array<{ total: number }>;

    const alreadyGranted = Number(totals[0]?.total ?? 0);
    const amount = Math.max(0, Math.min(LINK_BONUS_AMOUNT, LINK_BONUS_CAP - alreadyGranted));

    await tx`
      INSERT INTO credit_grants (
        profile_id, source_type, source_id, amount, metadata
      ) VALUES (
        ${profileId}, 'external_account_link', ${sourceId}, ${amount},
        ${JSON.stringify({ platform, external_id: normalizedExternalId })}::jsonb
      )
    `;

    if (amount === 0) return 0;

    await tx`
      INSERT INTO wallets (profile_id)
      VALUES (${profileId})
      ON CONFLICT (profile_id) DO NOTHING
    `;

    await tx`
      UPDATE wallets
      SET credit_available = credit_available + ${amount}
      WHERE profile_id = ${profileId}
    `;

    await tx`
      INSERT INTO credit_ledger_entries (
        profile_id, direction, amount, category, reference_type, reference_id, metadata
      ) VALUES (
        ${profileId}, 'C', ${amount}, 'link_bonus', 'external_account', ${sourceId},
        ${JSON.stringify({ platform, external_id: normalizedExternalId })}::jsonb
      )
    `;

    await createNotification(
      {
        profileId,
        type: 'credit.link_bonus_granted',
        category: 'credits',
        title: `+${amount} credits for linking ${platform}`,
        body: `You linked your ${platform} account and earned ${amount} credits.`,
        data: { amount, platform, external_id: normalizedExternalId },
        actionUrl: '/account/wallet',
      },
      tx,
    );

    return amount;
  })) as number;

  return { granted };
}

export type ReferralGrantReason =
  | 'unknown_code'
  | 'self_referral'
  | 'already_credited'
  | 'cap_reached'
  | 'ok';

export async function grantReferralCredits(
  referrerCode: string,
  referredProfileId: string,
): Promise<{ granted: number; reason: ReferralGrantReason }> {
  const normalizedCode = referrerCode.trim().toLowerCase();
  if (!normalizedCode) return { granted: 0, reason: 'unknown_code' };

  const sql = getPracticeDb();

  const txResult = (await sql.begin(async (tx) => {
    const referrers = (await tx`
      SELECT id FROM profiles WHERE referral_code = ${normalizedCode} LIMIT 1
    `) as Array<{ id: string }>;
    const referrer = referrers[0];
    if (!referrer) return { granted: 0, reason: 'unknown_code' as const };

    await tx`SELECT pg_advisory_xact_lock(hashtext(${referrer.id})::bigint)`;

    if (referrer.id === referredProfileId) {
      await tx`
        INSERT INTO referrals (
          referrer_profile_id, referred_profile_id, referral_code,
          status, rejection_reason
        ) VALUES (
          ${referrer.id}, ${referredProfileId}, ${normalizedCode},
          'rejected', 'self_referral'
        )
        ON CONFLICT (referred_profile_id) DO NOTHING
      `;
      return { granted: 0, reason: 'self_referral' as const };
    }

    const existing = (await tx`
      SELECT status FROM referrals
      WHERE referred_profile_id = ${referredProfileId}
      LIMIT 1
    `) as Array<{ status: string }>;
    if (existing.length > 0) {
      return { granted: 0, reason: 'already_credited' as const };
    }

    const totals = (await tx`
      SELECT COALESCE(SUM(amount), 0)::int AS total
      FROM credit_grants
      WHERE profile_id = ${referrer.id}
        AND source_type = 'referral'
    `) as Array<{ total: number }>;
    const alreadyGranted = Number(totals[0]?.total ?? 0);
    if (alreadyGranted >= REFERRAL_BONUS_CAP) {
      await tx`
        INSERT INTO referrals (
          referrer_profile_id, referred_profile_id, referral_code,
          status, rejection_reason
        ) VALUES (
          ${referrer.id}, ${referredProfileId}, ${normalizedCode},
          'rejected', 'cap_reached'
        )
        ON CONFLICT (referred_profile_id) DO NOTHING
      `;
      return { granted: 0, reason: 'cap_reached' as const };
    }

    const amount = Math.min(REFERRAL_BONUS_AMOUNT, REFERRAL_BONUS_CAP - alreadyGranted);

    await tx`
      INSERT INTO credit_grants (
        profile_id, source_type, source_id, amount, metadata
      ) VALUES (
        ${referrer.id}, 'referral', ${referredProfileId}, ${amount},
        ${JSON.stringify({ referred_profile_id: referredProfileId })}::jsonb
      )
    `;

    await tx`
      INSERT INTO wallets (profile_id)
      VALUES (${referrer.id})
      ON CONFLICT (profile_id) DO NOTHING
    `;

    await tx`
      UPDATE wallets
      SET credit_available = credit_available + ${amount}
      WHERE profile_id = ${referrer.id}
    `;

    await tx`
      INSERT INTO credit_ledger_entries (
        profile_id, direction, amount, category, reference_type, reference_id, metadata
      ) VALUES (
        ${referrer.id}, 'C', ${amount}, 'referral_bonus', 'profile', ${referredProfileId},
        ${JSON.stringify({ referral_code: normalizedCode })}::jsonb
      )
    `;

    await tx`
      INSERT INTO referrals (
        referrer_profile_id, referred_profile_id, referral_code,
        status, credited_at
      ) VALUES (
        ${referrer.id}, ${referredProfileId}, ${normalizedCode},
        'credited', NOW()
      )
    `;

    // Look up referee display details for the notification body. We respect
    // profile visibility: a private referee shows as "a new friend" rather
    // than leaking their display name to the referrer.
    const refereeRows = (await tx`
      SELECT display_name, profile_visibility
      FROM profiles
      WHERE id = ${referredProfileId}::uuid
    `) as Array<{ display_name: string | null; profile_visibility: string }>;
    const referee = refereeRows[0];
    const refereeLabel =
      referee && referee.profile_visibility === 'public' && referee.display_name
        ? referee.display_name
        : 'A new friend';

    await createNotification(
      {
        profileId: referrer.id,
        type: 'credit.referral_granted',
        category: 'credits',
        title: `+${amount} credits — ${refereeLabel} joined`,
        body: `${refereeLabel} signed up with your referral link.`,
        data: { amount, referred_profile_id: referredProfileId, referee_label: refereeLabel },
        actionUrl: '/account/wallet',
      },
      tx,
    );

    return {
      granted: amount,
      reason: 'ok' as const,
      referrerId: referrer.id,
      refereeLabel,
    };
  })) as
    | { granted: number; reason: ReferralGrantReason }
    | { granted: number; reason: 'ok'; referrerId: string; refereeLabel: string };

  // Email AFTER the tx commits — never block the credit grant on Resend.
  if (txResult.granted > 0 && 'referrerId' in txResult) {
    await sendNotificationEmail(txResult.referrerId, 'credits', {
      template: 'referral_credited',
      input: {
        displayName: null,
        refereeLabel: txResult.refereeLabel,
        amount: txResult.granted,
        walletUrl: `${appOrigin()}/account/wallet`,
      },
    });
  }

  return { granted: txResult.granted, reason: txResult.reason };
}
