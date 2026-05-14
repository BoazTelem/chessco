import { Chess } from 'chess.js';
import { leakFingerprint } from './fingerprint';
import type { Leak, LeakStats, MoveQualityIndex, ScoreOptions, SerializedTree } from './types';

const STARTING_FEN_KEY = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';

const DEFAULTS = {
  maxPlies: 30,
  minGamesCount: 3,
  maxPersonalized: 10,
  maxSurprise: 3,
};

function normalizeFenKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

function postFenAfter(fen: string, uci: string): string | null {
  // fenKey is the first 4 fields (no halfmove/fullmove counters). chess.js
  // requires a full FEN; pad with sensible defaults — they don't affect the
  // normalized key we read back out.
  const full = fen.split(' ').length >= 6 ? fen : `${fen} 0 1`;
  const board = new Chess();
  try {
    board.load(full);
  } catch {
    return null;
  }
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length > 4 ? uci[4] : undefined;
  try {
    const move = board.move({ from, to, promotion });
    if (!move) return null;
  } catch {
    return null;
  }
  return normalizeFenKey(board.fen());
}

interface Candidate {
  fenKey: string;
  sanPath: string[];
  userMoveSan: string;
  userMoveUci: string;
  opponentBadMoveSan: string;
  opponentBadMoveUci: string;
  stats: LeakStats;
  score: number;
}

function severity(quality: {
  avgCpLoss: number;
  blunderRate: number;
  mistakeRate: number;
}): number {
  const cp = Math.min(1.5, quality.avgCpLoss / 200);
  return cp + 0.5 * quality.blunderRate + 0.25 * quality.mistakeRate;
}

function passesQualityFloor(
  q: { avgCpLoss: number; blunderRate: number; mistakeRate: number; gamesCount: number },
  minGamesCount: number,
): boolean {
  if (q.gamesCount < minGamesCount) return false;
  return q.avgCpLoss >= 100 || q.mistakeRate > 0 || q.blunderRate > 0;
}

interface DfsContext {
  userTree: SerializedTree;
  opponentTree: SerializedTree;
  moveQualityByFenAndUci: MoveQualityIndex;
  userTreeTotalWeighted: number;
  opponentTreeTotalWeighted: number;
  userColor: 'white' | 'black';
  maxPlies: number;
  minGamesCount: number;
  out: Candidate[];
}

// depth 0 = starting position = white-to-move; depth flips every ply.
function isUserToMove(plyDepth: number, userColor: 'white' | 'black'): boolean {
  const whiteToMove = plyDepth % 2 === 0;
  return (userColor === 'white') === whiteToMove;
}

function visit(
  ctx: DfsContext,
  fenKey: string,
  sanPath: string[],
  plyDepth: number,
  visited: Set<string>,
): void {
  if (plyDepth >= ctx.maxPlies) return;
  if (visited.has(fenKey)) return;
  visited.add(fenKey);

  const userNode = ctx.userTree[fenKey];
  if (!userNode) return;
  if (userNode.totalWeighted <= 0) return;

  if (!isUserToMove(plyDepth, ctx.userColor)) {
    // Opponent-to-move ply in U's tree. Children are random opponents'
    // actual moves against U; we don't emit candidates here, just descend
    // one ply so the next layer is U-to-move.
    for (const child of Object.values(userNode.children)) {
      const after = postFenAfter(fenKey, child.uci);
      if (!after) continue;
      visit(ctx, after, [...sanPath, child.san], plyDepth + 1, visited);
    }
    return;
  }

  // U-to-move ply. Each child is U's move; the resulting position is
  // O-to-move and lives in O's opposite-color tree.
  for (const mU of Object.values(userNode.children)) {
    const postFen = postFenAfter(fenKey, mU.uci);
    if (!postFen) continue;

    const oppNode = ctx.opponentTree[postFen];
    if (oppNode && oppNode.totalGames > 0) {
      for (const mO of Object.values(oppNode.children)) {
        const quality = ctx.moveQualityByFenAndUci.get(`${postFen}|${mO.uci}`);
        if (!quality) continue;
        if (!passesQualityFloor(quality, ctx.minGamesCount)) continue;

        const userReach =
          (userNode.totalWeighted / ctx.userTreeTotalWeighted) *
          (mU.weightedScore / Math.max(userNode.totalWeighted, 1e-9));
        const opponentReach = oppNode.totalWeighted / ctx.opponentTreeTotalWeighted;
        const badMoveShare = mO.gamesCount / Math.max(oppNode.totalGames, 1);
        const sev = severity(quality);
        const score = userReach * opponentReach * badMoveShare * sev;
        if (score <= 0) continue;

        ctx.out.push({
          fenKey: postFen,
          sanPath: [...sanPath, mU.san],
          userMoveSan: mU.san,
          userMoveUci: mU.uci,
          opponentBadMoveSan: mO.san,
          opponentBadMoveUci: mO.uci,
          stats: {
            gamesCount: quality.gamesCount,
            blunderRate: quality.blunderRate,
            mistakeRate: quality.mistakeRate,
            avgCpLoss: quality.avgCpLoss,
            userReach,
            opponentReach,
            badMoveShare,
          },
          score,
        });
      }
    }

    // Recurse two plies (U-move then O-move) so the next call lands on a
    // U-to-move position again. We use U's tree for the O response so the
    // walk follows lines U has actually faced.
    const userPostNode = ctx.userTree[postFen];
    if (userPostNode) {
      for (const mO of Object.values(userPostNode.children)) {
        const afterO = postFenAfter(postFen, mO.uci);
        if (!afterO) continue;
        visit(ctx, afterO, [...sanPath, mU.san, mO.san], plyDepth + 2, visited);
      }
    }
  }
}

export function scoreLeaks(args: {
  userTree: SerializedTree;
  opponentTree: SerializedTree;
  moveQualityByFenAndUci: MoveQualityIndex;
  opts: ScoreOptions;
}): Leak[] {
  const { userTree, opponentTree, moveQualityByFenAndUci, opts } = args;
  const maxPlies = opts.maxPlies ?? DEFAULTS.maxPlies;
  const minGamesCount = opts.minGamesCount ?? DEFAULTS.minGamesCount;
  const maxPersonalized = opts.maxPersonalized ?? DEFAULTS.maxPersonalized;
  const maxSurprise = opts.maxSurprise ?? DEFAULTS.maxSurprise;

  const userRoot = userTree[STARTING_FEN_KEY];
  const opponentRoot = opponentTree[STARTING_FEN_KEY];
  const userTreeTotalWeighted = userRoot?.totalWeighted ?? sumWeighted(userTree);
  const opponentTreeTotalWeighted = opponentRoot?.totalWeighted ?? sumWeighted(opponentTree);

  if (userTreeTotalWeighted <= 0 || opponentTreeTotalWeighted <= 0) {
    return scoreSurprise({
      opponentTree,
      moveQualityByFenAndUci,
      opts,
      excludedFenKeys: new Set(),
      opponentTreeTotalWeighted: Math.max(opponentTreeTotalWeighted, 1e-9),
      maxSurprise,
      minGamesCount,
    });
  }

  const candidates: Candidate[] = [];
  visit(
    {
      userTree,
      opponentTree,
      moveQualityByFenAndUci,
      userTreeTotalWeighted,
      opponentTreeTotalWeighted,
      userColor: opts.userColor,
      maxPlies,
      minGamesCount,
      out: candidates,
    },
    STARTING_FEN_KEY,
    [],
    0,
    new Set<string>(),
  );

  const personalized = dedupeByFingerprint(
    candidates.sort((a, b) => b.score - a.score),
    opts,
    'personalized',
  ).slice(0, maxPersonalized);

  const excluded = new Set(personalized.map((l) => l.fenKey));
  const surprise = scoreSurprise({
    opponentTree,
    moveQualityByFenAndUci,
    opts,
    excludedFenKeys: excluded,
    opponentTreeTotalWeighted,
    maxSurprise,
    minGamesCount,
  });

  return [...personalized, ...surprise];
}

function sumWeighted(tree: SerializedTree): number {
  // Fallback when no root node — use the largest single-node weight as an
  // upper bound. Should not happen for trees built by the worker.
  let max = 0;
  for (const node of Object.values(tree)) {
    if (node.totalWeighted > max) max = node.totalWeighted;
  }
  return max;
}

function dedupeByFingerprint(
  candidates: Candidate[],
  opts: ScoreOptions,
  kind: 'personalized' | 'surprise',
): Leak[] {
  const seen = new Set<string>();
  const out: Leak[] = [];
  for (const c of candidates) {
    const fp = leakFingerprint({
      platform: opts.platform,
      handleNormalized: opts.handleNormalized,
      userColor: opts.userColor,
      kind,
      fenKey: c.fenKey,
      userMoveUci: c.userMoveUci,
      opponentBadMoveUci: c.opponentBadMoveUci,
    });
    if (seen.has(fp)) continue;
    seen.add(fp);
    out.push({
      fingerprint: fp,
      fenKey: c.fenKey,
      sanPath: c.sanPath,
      userMoveSan: c.userMoveSan,
      userMoveUci: c.userMoveUci,
      opponentBadMoveSan: c.opponentBadMoveSan,
      opponentBadMoveUci: c.opponentBadMoveUci,
      opponentBetterMoveSan: null,
      stats: c.stats,
      kind,
      score: c.score,
    });
  }
  return out;
}

function scoreSurprise(args: {
  opponentTree: SerializedTree;
  moveQualityByFenAndUci: MoveQualityIndex;
  opts: ScoreOptions;
  excludedFenKeys: Set<string>;
  opponentTreeTotalWeighted: number;
  maxSurprise: number;
  minGamesCount: number;
}): Leak[] {
  const {
    opponentTree,
    moveQualityByFenAndUci,
    opts,
    excludedFenKeys,
    opponentTreeTotalWeighted,
    maxSurprise,
    minGamesCount,
  } = args;

  const candidates: Candidate[] = [];
  for (const [fenKey, oppNode] of Object.entries(opponentTree)) {
    if (excludedFenKeys.has(fenKey)) continue;
    if (oppNode.totalGames === 0) continue;
    for (const mO of Object.values(oppNode.children)) {
      const quality = moveQualityByFenAndUci.get(`${fenKey}|${mO.uci}`);
      if (!quality) continue;
      if (!passesQualityFloor(quality, minGamesCount)) continue;

      const opponentReach = oppNode.totalWeighted / opponentTreeTotalWeighted;
      const badMoveShare = mO.gamesCount / Math.max(oppNode.totalGames, 1);
      const sev = severity(quality);
      const score = opponentReach * badMoveShare * sev;
      if (score <= 0) continue;

      const userMoveSan = '';
      const userMoveUci = '';

      candidates.push({
        fenKey,
        sanPath: [],
        userMoveSan,
        userMoveUci,
        opponentBadMoveSan: mO.san,
        opponentBadMoveUci: mO.uci,
        stats: {
          gamesCount: quality.gamesCount,
          blunderRate: quality.blunderRate,
          mistakeRate: quality.mistakeRate,
          avgCpLoss: quality.avgCpLoss,
          userReach: 0,
          opponentReach,
          badMoveShare,
        },
        score,
      });
    }
  }

  return dedupeByFingerprint(
    candidates.sort((a, b) => b.score - a.score),
    opts,
    'surprise',
  ).slice(0, maxSurprise);
}
