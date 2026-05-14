import { getPracticeDb } from '@/lib/practice/db';
import type { Platform } from './types';

export interface UnlockResult {
  status: 'unlocked' | 'insufficient_credits';
  cost: 0 | 1;
  unlockId: string | null;
}

/**
 * Atomically reveal a leak: idempotent on (profile, platform, handle,
 * fingerprint); first reveal per (profile, platform, handle) is free, the
 * rest cost 1 credit. All state changes happen inside a single transaction
 * guarded by an advisory lock on the profile id.
 */
export async function unlockLeak(args: {
  profileId: string;
  platform: Platform;
  handleNormalized: string;
  leakFingerprint: string;
  prepReportId: string;
}): Promise<UnlockResult> {
  const { profileId, platform, handleNormalized, leakFingerprint, prepReportId } = args;
  const sql = getPracticeDb();

  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${profileId})::bigint)`;

    const existing = (await tx`
      SELECT id, cost_credits FROM prep_leak_unlocks
      WHERE profile_id = ${profileId}
        AND target_platform = ${platform}
        AND target_handle_normalized = ${handleNormalized}
        AND leak_fingerprint = ${leakFingerprint}
      LIMIT 1
    `) as Array<{ id: string; cost_credits: number }>;

    if (existing.length > 0) {
      const row = existing[0]!;
      return {
        status: 'unlocked' as const,
        cost: (row.cost_credits === 1 ? 1 : 0) as 0 | 1,
        unlockId: row.id,
      };
    }

    const freeUsed = await tx`
      SELECT 1 AS marker FROM prep_leak_unlocks
      WHERE profile_id = ${profileId}
        AND target_platform = ${platform}
        AND target_handle_normalized = ${handleNormalized}
        AND cost_credits = 0
      LIMIT 1
    `;

    const cost: 0 | 1 = freeUsed.length > 0 ? 1 : 0;

    if (cost === 1) {
      const debited = (await tx`
        UPDATE wallets
        SET credit_available = credit_available - 1,
            updated_at = NOW()
        WHERE profile_id = ${profileId}
          AND credit_available >= 1
        RETURNING credit_available
      `) as Array<{ credit_available: number }>;

      if (debited.length === 0) {
        return {
          status: 'insufficient_credits' as const,
          cost: 1 as const,
          unlockId: null,
        };
      }
    }

    const inserted = (await tx`
      INSERT INTO prep_leak_unlocks (
        profile_id, target_platform, target_handle_normalized,
        leak_fingerprint, prep_report_id, cost_credits
      ) VALUES (
        ${profileId}, ${platform}, ${handleNormalized},
        ${leakFingerprint}, ${prepReportId}, ${cost}
      )
      RETURNING id
    `) as Array<{ id: string }>;

    const unlockId = inserted[0]!.id;

    if (cost === 1) {
      await tx`
        INSERT INTO credit_ledger_entries (
          profile_id, direction, amount, category, reference_type, reference_id, metadata
        ) VALUES (
          ${profileId}, 'D', 1, 'prep_leak_reveal', 'prep_leak_unlock', ${unlockId},
          ${JSON.stringify({
            platform,
            handle_normalized: handleNormalized,
            leak_fingerprint: leakFingerprint,
            prep_report_id: prepReportId,
          })}::jsonb
        )
      `;
    }

    return { status: 'unlocked' as const, cost, unlockId };
  });
}
