import { getGamesDb } from './readiness';
import { getPracticeDb } from '@/lib/practice/db';
import { loadMoveQuality } from './load-move-quality';
import { loadRepertoireTree } from './load-trees';
import { mergeTrees } from './merge';
import { scoreLeaks } from './score';
import type { Leak, Platform } from './types';

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

    const leaks = scoreLeaks({
      userTree,
      opponentTree,
      moveQualityByFenAndUci: moveQuality,
      opts: {
        platform: targetPlatform,
        handleNormalized: targetHandleNormalized,
        userColor,
      },
    });
    out[userColor] = leaks;
  }

  return out;
}
