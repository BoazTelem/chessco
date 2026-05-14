import { getPracticeDb } from '@/lib/practice/db';

const LINK_BONUS_AMOUNT = 5;
const LINK_BONUS_CAP = 10;
const LINK_BONUS_PLATFORMS = new Set(['lichess', 'chess.com']);

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
