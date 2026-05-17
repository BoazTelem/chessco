/**
 * Promote-ad-hoc worker.
 *
 * The back-feed completion of the cold-tail fallback. When a signed-in user
 * marks a Stage 2/3 candidate `correct` on a query anchored on an ad-hoc
 * player, /api/candidate/{id}/feedback writes a row to ad_hoc_player_handles
 * and bumps ad_hoc_players.confirmed_match_count. This worker scans the
 * pending pool and decides:
 *
 *   - ≥ 2 distinct confirmer profiles on the same (platform, handle)?
 *     → promotion_status = 'promoted'. The ad-hoc row stays an ad-hoc row,
 *       but its preferred handle is now community-verified and /scout
 *       surfaces it below the canonical FIDE results.
 *
 *   - A federation_players row matches the ad-hoc row's name (trigram
 *     similarity >= 0.85) and country?
 *     → promotion_status = 'duplicate_of_fide', promoted_federation_player_id
 *       set. We don't promote — the canonical FIDE row already covers this
 *       person; promoting would clutter /scout with dups.
 *
 *   - Otherwise stays 'pending' for the next scan.
 *
 * Idempotent and safe to run repeatedly (re-promoting a 'promoted' row is a
 * no-op; the WHERE clause filters them out).
 *
 * CLI:   tsx src/identification/promote-ad-hoc.ts [--limit 200] [--dry-run]
 * Cron:  registered in src/inngest/promote-ad-hoc.ts as nightly 04:30 UTC.
 */
import 'dotenv/config';
import type postgres from 'postgres';
import { getDb } from '../db.js';

const MIN_DISTINCT_CONFIRMERS = 2;
const FIDE_DUPLICATE_SIMILARITY = 0.85;

export interface PromoteResult {
  scanned: number;
  promoted: number;
  duplicates_of_fide: number;
  skipped_insufficient_confirmers: number;
  skipped_no_handle: number;
}

interface AdHocPendingRow {
  id: string;
  name_normalized: string;
  country: string | null;
}

interface HandleConfirmerRow {
  ad_hoc_player_id: string;
  platform: 'lichess' | 'chess.com';
  handle: string;
  confirmed_by: string;
}

interface FedDuplicateRow {
  federation_player_id: string;
  sim: number;
}

/**
 * Run one promotion pass against the live Supabase Postgres. `limit` caps
 * the scan per tick so a backlog doesn't time out the cron.
 */
export async function promoteAdHocPlayers(
  sql: postgres.Sql,
  { limit = 200, dryRun = false }: { limit?: number; dryRun?: boolean } = {},
): Promise<PromoteResult> {
  const result: PromoteResult = {
    scanned: 0,
    promoted: 0,
    duplicates_of_fide: 0,
    skipped_insufficient_confirmers: 0,
    skipped_no_handle: 0,
  };

  // 1. Pending ad-hoc rows with enough confirmer-count to be worth checking.
  //    The denormalized confirmed_match_count is a lower-bound — the
  //    authoritative DISTINCT-by-handle check happens below.
  const pending = await sql<AdHocPendingRow[]>`
    SELECT id, name_normalized, country
      FROM ad_hoc_players
     WHERE promotion_status = 'pending'
       AND confirmed_match_count >= ${MIN_DISTINCT_CONFIRMERS}
     ORDER BY confirmed_match_count DESC
     LIMIT ${limit}
  `;
  result.scanned = pending.length;
  if (pending.length === 0) return result;

  const ids = pending.map((r) => r.id);

  // 2. Batch-load every confirmation tuple in one round-trip.
  const handles = await sql<HandleConfirmerRow[]>`
    SELECT ad_hoc_player_id, platform, handle, confirmed_by
      FROM ad_hoc_player_handles
     WHERE ad_hoc_player_id = ANY(${ids}::uuid[])
  `;

  // Group → ad_hoc_player_id → (platform, handle) → Set<confirmer_id>.
  // Best (platform, handle) per anchor = the pair with the most distinct
  // confirmers. Ties broken by lexical order (deterministic).
  const byAnchor = new Map<string, Map<string, Set<string>>>();
  for (const r of handles) {
    const inner = byAnchor.get(r.ad_hoc_player_id) ?? new Map<string, Set<string>>();
    const key = `${r.platform}:${r.handle}`;
    const set = inner.get(key) ?? new Set<string>();
    set.add(r.confirmed_by);
    inner.set(key, set);
    byAnchor.set(r.ad_hoc_player_id, inner);
  }

  for (const cand of pending) {
    const inner = byAnchor.get(cand.id);
    if (!inner || inner.size === 0) {
      result.skipped_no_handle++;
      continue;
    }

    let bestKey = '';
    let bestSize = 0;
    for (const [key, set] of inner.entries()) {
      if (set.size > bestSize || (set.size === bestSize && (bestKey === '' || key < bestKey))) {
        bestKey = key;
        bestSize = set.size;
      }
    }
    if (bestSize < MIN_DISTINCT_CONFIRMERS) {
      result.skipped_insufficient_confirmers++;
      continue;
    }

    // 3. FIDE-duplicate check via pg_trgm on name_normalized. The
    //    federation_players name_trgm_idx is already in place; this is a
    //    single-row trigram lookup with similarity gate.
    const dupRows = await sql<FedDuplicateRow[]>`
      SELECT id AS federation_player_id,
             similarity(name_normalized, ${cand.name_normalized}) AS sim
        FROM federation_players
       WHERE name_normalized % ${cand.name_normalized}
         ${cand.country ? sql`AND country = ${cand.country}` : sql``}
       ORDER BY sim DESC
       LIMIT 1
    `;
    const fedHit = dupRows[0] && dupRows[0].sim >= FIDE_DUPLICATE_SIMILARITY ? dupRows[0] : null;

    if (fedHit) {
      if (!dryRun) {
        await sql`
          UPDATE ad_hoc_players
             SET promotion_status = 'duplicate_of_fide',
                 promoted_federation_player_id = ${fedHit.federation_player_id}::uuid
           WHERE id = ${cand.id}::uuid
        `;
      }
      result.duplicates_of_fide++;
      continue;
    }

    if (!dryRun) {
      await sql`
        UPDATE ad_hoc_players
           SET promotion_status = 'promoted'
         WHERE id = ${cand.id}::uuid
      `;
    }
    result.promoted++;
  }

  return result;
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const limitArg = argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1] ?? '200', 10) : 200;

  const { client } = getDb();
  try {
    const t0 = Date.now();
    const r = await promoteAdHocPlayers(client, { limit, dryRun });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `[promote-ad-hoc] ${dryRun ? '(dry-run) ' : ''}scanned=${r.scanned} promoted=${r.promoted} ` +
        `dup_fide=${r.duplicates_of_fide} skipped_low=${r.skipped_insufficient_confirmers} ` +
        `skipped_no_handle=${r.skipped_no_handle} · ${elapsed}s`,
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

const isCli = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`;
if (isCli) {
  main().catch((err) => {
    console.error('[promote-ad-hoc] failed:', err);
    process.exit(1);
  });
}
