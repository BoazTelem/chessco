import { getPracticeDb } from '@/lib/practice/db';

const LINK_BONUS_AMOUNT = 5;
const LINK_BONUS_CAP = 10;
const LINK_BONUS_PLATFORMS = new Set(['lichess', 'chess.com']);

export const REFERRAL_BONUS_AMOUNT = 20;
export const REFERRAL_BONUS_CAP = 100;

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

  return (await sql.begin(async (tx) => {
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

    return { granted: amount, reason: 'ok' as const };
  })) as { granted: number; reason: ReferralGrantReason };
}
