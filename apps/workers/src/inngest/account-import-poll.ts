/**
 * Account-import poller — Phase 1 W10 "Import your games" surface.
 *
 * After a user links a chess.com or Lichess account, account-fingerprint
 * seeds the platform crawl queue at ON_DEMAND priority and kicks the
 * watchdog. The Cloud Run crawler ingests their games into the corpus.
 * This poller then builds the per-account player_repertoires tree so the
 * user has a personal opening repertoire ready before they ever hit
 * /prepare against an opponent.
 *
 * On each tick:
 *   1. Query Supabase for verified external_accounts (lichess + chess.com).
 *   2. Cross-check the games corpus for each (platform, handle) pair:
 *      - if the handle has games_seen >= MIN_GAMES_FOR_TREE,
 *      - AND there is no player_repertoires row at depth 12,
 *      → build the tree via buildAndPersist.
 *   3. Process up to BATCH_LIMIT accounts per tick to avoid hogging the
 *      Inngest worker pool (each build is ~1–5s for a typical user).
 *
 * Skips accounts that already have a repertoire — the existing
 * prepare-reports poller handles staleness rebuilds when the user
 * actually runs a prep report. This worker is purely about getting the
 * first build done eagerly so the dashboard can show "ready" status.
 *
 * Cron: every 1 minute. Manual: chessco/account-import.poll.requested.
 */
import postgres from 'postgres';
import { getDb, getGamesDb } from '../db.js';
import { buildAndPersist, lookupHandleId } from '../repertoires/build.js';
import { inngest } from './client.js';

const REPERTOIRE_DEPTH = 12;
// Need at least this many games before a personal repertoire is meaningful.
// Below this we let the crawler keep filling the corpus and check again next
// tick. The bulk-backfill builder uses scout_ready_at (>=20 games typically)
// but we're more permissive here since the user is actively waiting.
const MIN_GAMES_FOR_TREE = 10;
// Per-tick cap. Each buildAndPersist queries games+moves+positions for one
// handle and writes up to 8 player_repertoires rows (4 buckets × 2 colors).
// Empirically ~1–5s per handle, so 10 keeps a tick well under 60s.
const BATCH_LIMIT = 10;

interface PendingAccount {
  profile_id: string;
  platform: 'lichess' | 'chess.com';
  external_id: string;
}

/**
 * Find verified external_accounts whose Supabase-side row exists but whose
 * games-corpus side either lacks a player_repertoires row or lacks a handles
 * row entirely (still crawling). We can't JOIN across DBs, so we pull the
 * full verified-account list from Supabase and filter in memory — the list
 * is bounded by the verified-user count, which is small at this stage.
 */
async function listVerifiedAccounts(supa: postgres.Sql): Promise<PendingAccount[]> {
  return supa<PendingAccount[]>`
    SELECT profile_id::text, platform, external_id
    FROM external_accounts
    WHERE verified = true
      AND platform IN ('lichess', 'chess.com')
    ORDER BY created_at DESC
  `;
}

/**
 * Per (platform, handle): does the corpus have enough games AND no
 * existing repertoire at depth 12? Returns true if a build is warranted.
 */
async function shouldBuild(
  games: postgres.Sql,
  platform: 'lichess' | 'chess.com',
  handle: string,
): Promise<
  | { build: false; reason: 'unknown_handle' | 'too_few_games' | 'already_built' }
  | { build: true; playerId: string; canonicalHandle: string; gamesSeen: number }
> {
  const lookup = await lookupHandleId(games, platform, handle);
  if (!lookup) return { build: false, reason: 'unknown_handle' };
  const rows = await games<{ games_seen: number; rep_present: boolean }[]>`
    SELECT
      h.games_seen,
      EXISTS (
        SELECT 1 FROM player_repertoires pr
        WHERE pr.player_id = h.id AND pr.depth = ${REPERTOIRE_DEPTH}
      ) AS rep_present
    FROM handles h
    WHERE h.id = ${lookup.id}::uuid
  `;
  const row = rows[0];
  if (!row) return { build: false, reason: 'unknown_handle' };
  if (row.rep_present) return { build: false, reason: 'already_built' };
  if (row.games_seen < MIN_GAMES_FOR_TREE) return { build: false, reason: 'too_few_games' };
  return {
    build: true,
    playerId: lookup.id,
    canonicalHandle: lookup.handle,
    gamesSeen: row.games_seen,
  };
}

async function pollOnce(logger: {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}): Promise<{ checked: number; built: number; waiting: number; failed: number }> {
  const { client: supa } = getDb();
  const { client: games } = getGamesDb();
  let checked = 0;
  let built = 0;
  let waiting = 0;
  let failed = 0;
  try {
    const accounts = await listVerifiedAccounts(supa);
    for (const acc of accounts) {
      if (built >= BATCH_LIMIT) break;
      checked += 1;
      const decision = await shouldBuild(games, acc.platform, acc.external_id);
      if (!decision.build) {
        if (decision.reason === 'unknown_handle' || decision.reason === 'too_few_games') {
          waiting += 1;
        }
        continue;
      }
      try {
        const stats = await buildAndPersist(
          games,
          decision.playerId,
          acc.platform,
          decision.canonicalHandle,
          REPERTOIRE_DEPTH,
        );
        built += 1;
        logger.info(
          `[account-import] built ${acc.platform}/${decision.canonicalHandle}: ` +
            `${stats.games_total}g (${stats.games_white}w/${stats.games_black}b), ` +
            `${stats.buckets_written} bucket-rows, ` +
            `${stats.total_white_nodes}+${stats.total_black_nodes} nodes`,
        );
      } catch (err) {
        failed += 1;
        logger.warn(
          `[account-import] build failed for ${acc.platform}/${decision.canonicalHandle}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { checked, built, waiting, failed };
  } finally {
    await games.end({ timeout: 5 }).catch(() => undefined);
    await supa.end({ timeout: 5 }).catch(() => undefined);
  }
}

export const accountImportPoll = inngest.createFunction(
  {
    id: 'account-import-poll',
    name: 'Account import — repertoire builder (post-crawl)',
    concurrency: { limit: 1 },
    retries: 1,
  },
  [{ cron: '* * * * *' }, { event: 'chessco/account-import.poll.requested' }],
  async ({ logger }) => {
    const out = await pollOnce(logger);
    logger.info(
      `[account-import] tick: checked=${out.checked} built=${out.built} ` +
        `waiting=${out.waiting} failed=${out.failed}`,
    );
    return out;
  },
);
