import { getGamesDb } from './readiness';
import { getPracticeDb } from '@/lib/practice/db';
import { loadMoveQuality } from './load-move-quality';
import { loadRepertoireTree } from './load-trees';
import { mergeTrees } from './merge';
import { scoreLeaks, scoreOwnLeaks } from './score';
import type { Leak, MoveQualityIndex, Platform } from './types';

interface LinkedAccount {
  platform: Platform;
  external_id: string;
}

export interface ComputedLeaks {
  white: Leak[];
  black: Leak[];
  generated_at: string;
}

/**
 * Pull both colors' worth of leaks for a (user, opponent) pair from the
 * games corpus. Used by the GET /api/prepare/reports/[id] endpoint to
 * compute-and-cache leaks_json the first time it's requested for a
 * 'ready' report.
 */
export async function computeReportLeaks(args: {
  profileId: string;
  targetPlatform: Platform;
  targetHandleNormalized: string;
}): Promise<ComputedLeaks> {
  const { profileId, targetPlatform, targetHandleNormalized } = args;
  const supa = getPracticeDb();
  const games = getGamesDb();

  const linked = (await supa<LinkedAccount[]>`
    SELECT platform, external_id
    FROM external_accounts
    WHERE profile_id = ${profileId}
      AND platform IN ('lichess', 'chess.com')
      AND verified = true
  `) as LinkedAccount[];

  const moveQuality = await loadMoveQuality({
    games,
    platform: targetPlatform,
    handleNormalized: targetHandleNormalized,
  });

  // For "your own leaks": aggregate the signed-in user's move-quality across
  // every linked account they have. Same FEN can appear from both platforms
  // (normalized to first-4-field key) — combine by game-count-weighted blend.
  const userMoveQuality = await loadAggregatedMoveQuality(games, linked);

  const colors: Array<'white' | 'black'> = ['white', 'black'];
  const out: ComputedLeaks = {
    white: [],
    black: [],
    generated_at: new Date().toISOString(),
  };

  for (const userColor of colors) {
    const opponentColor = userColor === 'white' ? 'black' : 'white';

    const userTreeParts = await Promise.all(
      linked.map((acc) =>
        loadRepertoireTree({
          games,
          platform: acc.platform,
          handleNormalized: acc.external_id.trim().toLowerCase(),
          color: userColor,
        }),
      ),
    );
    const userTree = mergeTrees(
      userTreeParts.filter((t): t is NonNullable<typeof t> => t !== null),
    );

    const opponentTree = await loadRepertoireTree({
      games,
      platform: targetPlatform,
      handleNormalized: targetHandleNormalized,
      color: opponentColor,
    });

    if (!opponentTree) {
      out[userColor] = [];
      continue;
    }

    // Isolate per-color scoring so one color's edge-case throw can't
    // empty out the other color's leaks.
    const opts = {
      platform: targetPlatform,
      handleNormalized: targetHandleNormalized,
      userColor,
    };
    let their: Leak[] = [];
    let own: Leak[] = [];
    try {
      their = scoreLeaks({
        userTree,
        opponentTree,
        moveQualityByFenAndUci: moveQuality,
        opts,
      });
    } catch (err) {
      console.error(
        `[computeReportLeaks] scoreLeaks threw for color=${userColor} target=${targetPlatform}/${targetHandleNormalized}:`,
        err,
      );
    }
    try {
      own = scoreOwnLeaks({
        userTree,
        opponentTree,
        userMoveQualityByFenAndUci: userMoveQuality,
        opts,
      });
    } catch (err) {
      console.error(
        `[computeReportLeaks] scoreOwnLeaks threw for color=${userColor} target=${targetPlatform}/${targetHandleNormalized}:`,
        err,
      );
    }
    out[userColor] = [...their, ...own];
  }

  return out;
}

async function loadAggregatedMoveQuality(
  games: ReturnType<typeof getGamesDb>,
  linked: LinkedAccount[],
): Promise<MoveQualityIndex> {
  if (linked.length === 0) return new Map();
  const perAcc = await Promise.all(
    linked.map((acc) =>
      loadMoveQuality({
        games,
        platform: acc.platform,
        handleNormalized: acc.external_id.trim().toLowerCase(),
      }),
    ),
  );
  if (perAcc.length === 1) return perAcc[0]!;

  const out: MoveQualityIndex = new Map();
  for (const mq of perAcc) {
    for (const [key, val] of mq) {
      const existing = out.get(key);
      if (!existing) {
        out.set(key, val);
        continue;
      }
      const total = existing.gamesCount + val.gamesCount;
      if (total === 0) continue;
      out.set(key, {
        gamesCount: total,
        blunderRate:
          (existing.blunderRate * existing.gamesCount + val.blunderRate * val.gamesCount) / total,
        mistakeRate:
          (existing.mistakeRate * existing.gamesCount + val.mistakeRate * val.gamesCount) / total,
        avgCpLoss:
          (existing.avgCpLoss * existing.gamesCount + val.avgCpLoss * val.gamesCount) / total,
      });
    }
  }
  return out;
}
