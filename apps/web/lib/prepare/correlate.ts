/**
 * Two-player bucketed-repertoire correlation engine — Phase 4 of the
 * player-id pipeline. Given (your_handle, opponent_handle) and their
 * loaded `player_repertoires` slices, compute:
 *
 * 1. **Overlap**: positions you both reach (color-conditional — your
 *    White repertoire vs their Black, and vice versa). These are the
 *    lines that will actually appear in a real game.
 * 2. **Drift**: positions where the opponent's recent_3mo distribution
 *    or score differs materially from their all_time baseline. Flags
 *    style changes — "they switched away from the Najdorf this quarter".
 *
 * Architectural note on FEN keys: the worker's build (apps/workers/src/
 * repertoires/build.ts:135) only records positions where the PLAYER is
 * about to move. So `me_white.tree` contains only w-to-move FENs and
 * `opp_black.tree` contains only b-to-move FENs — the two key spaces
 * NEVER intersect directly. To find positions both players reach we
 * walk: for each (your_position, your_move), compute the FEN after
 * your move (now opponent's turn) and look it up in their tree.
 *
 * The engine is pure (no DB / network) — see load-repertoires.ts for
 * the data loader, and /api/prepare/correlate for the HTTP wrapper.
 */
import { Chess } from 'chess.js';
import type {
  RepertoireSlice,
  SerializedNextMoveStats,
  SerializedTreeNode,
} from './load-repertoires';

function fenKeyToFullFen(fenKey: string): string {
  // Tree keys are 4-field FENs (pieces, side, castling, ep). chess.js
  // requires 6 fields; append the standard halfmove + fullmove counters.
  // The 0/1 values are meaningful only for the 50-move rule and game
  // numbering, neither of which affects move legality for our purposes.
  return `${fenKey} 0 1`;
}

function fullFenToKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

/**
 * Apply a UCI move to a 4-field FEN key and return the resulting key.
 * Returns null if the move is illegal in the given position (defensive —
 * shouldn't happen for trees built from real games, but guards against
 * data corruption or castling-rights mismatches across rebuilds).
 */
function applyUciToFenKey(fenKey: string, uci: string): string | null {
  const game = new Chess();
  try {
    game.load(fenKeyToFullFen(fenKey));
  } catch {
    return null;
  }
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length > 4 ? uci[4] : undefined;
  try {
    const moved = game.move({ from, to, promotion });
    if (!moved) return null;
  } catch {
    return null;
  }
  return fullFenToKey(game.fen());
}

// ---------------------------------------------------------------------------
// Overlap — color-conditional intersection of two trees
// ---------------------------------------------------------------------------

export interface OverlapPosition {
  /** FEN key in YOUR tree — the position where you are to move. */
  yourFenKey: string;
  /** The specific move of yours that creates the bridge. */
  yourMove: TopMoveSummary;
  /** FEN key in THEIR tree — position after your move (opponent to respond). */
  theirFenKey: string;
  /** Their top responses to your move at this position. */
  theirResponses: TopMoveSummary[];
  /** Their aggregate score across all their responses (their perspective). */
  theirAggregate: AggregateScore;
  /** Weighted opportunity score — your-move-frequency × their-response-volume × (1 - their_score_share). Higher = better prep target. */
  opportunityScore: number;
}

export interface TopMoveSummary {
  san: string;
  uci: string;
  gamesCount: number;
  wins: number;
  draws: number;
  losses: number;
  scoreShare: number; // wins+0.5*draws fraction
}

export interface AggregateScore {
  totalGames: number;
  wins: number;
  draws: number;
  losses: number;
  scoreShare: number;
}

export interface CorrelateOptions {
  /** Minimum games at a position to consider it for overlap. Filters noise. */
  minGamesPerSide?: number;
  /** Maximum number of overlap positions to return. */
  maxPositions?: number;
  /** Number of top moves to surface per side at each position. */
  topMovesPerSide?: number;
}

const DEFAULT_MIN_GAMES = 3;
const DEFAULT_MAX_POSITIONS = 25;
const DEFAULT_TOP_MOVES = 3;

function aggregateChildren(node: SerializedTreeNode): AggregateScore {
  let total = 0;
  let wins = 0;
  let draws = 0;
  let losses = 0;
  for (const child of Object.values(node.children)) {
    total += child.gamesCount;
    wins += child.wins;
    draws += child.draws;
    losses += child.losses;
  }
  const scoreShare = total === 0 ? 0 : (wins + 0.5 * draws) / total;
  return { totalGames: total, wins, draws, losses, scoreShare };
}

function topMoves(node: SerializedTreeNode, n: number): TopMoveSummary[] {
  const all = Object.values(node.children).sort((a, b) => b.weightedScore - a.weightedScore);
  return all.slice(0, n).map((m) => ({
    san: m.san,
    uci: m.uci,
    gamesCount: m.gamesCount,
    wins: m.wins,
    draws: m.draws,
    losses: m.losses,
    scoreShare: m.gamesCount === 0 ? 0 : (m.wins + 0.5 * m.draws) / m.gamesCount,
  }));
}

/**
 * Find lines where YOUR move leads to a position THEY also reach (and
 * face responses for). The two trees use disjoint FEN-key spaces (yours
 * only has w-to-move or only has b-to-move depending on your color, and
 * theirs is the opposite parity), so we bridge them by applying your
 * move to your position and looking up the resulting opponent-to-move
 * FEN in their tree.
 *
 * Use this with (yourWhite + theirBlack) to analyze your White
 * repertoire against their Black, or (yourBlack + theirWhite) for the
 * other direction. Returns positions sorted by `opportunityScore`:
 * your-move-frequency × their-response-volume × (1 - their_score_share),
 * surfacing prep targets that you play often AND they handle poorly.
 */
export function correlateOverlap(
  you: RepertoireSlice | null,
  them: RepertoireSlice | null,
  opts: CorrelateOptions = {},
): OverlapPosition[] {
  if (!you || !them) return [];
  const minGames = opts.minGamesPerSide ?? DEFAULT_MIN_GAMES;
  const maxPositions = opts.maxPositions ?? DEFAULT_MAX_POSITIONS;
  const topN = opts.topMovesPerSide ?? DEFAULT_TOP_MOVES;

  const out: OverlapPosition[] = [];
  for (const [yourFenKey, yourNode] of Object.entries(you.tree)) {
    if (yourNode.totalGames < minGames) continue;
    for (const yourMoveStats of Object.values(yourNode.children)) {
      if (yourMoveStats.gamesCount < minGames) continue;
      const nextFen = applyUciToFenKey(yourFenKey, yourMoveStats.uci);
      if (!nextFen) continue;
      const theirNode = them.tree[nextFen];
      if (!theirNode || theirNode.totalGames < minGames) continue;

      const theirAgg = aggregateChildren(theirNode);
      const yourMoveSummary: TopMoveSummary = {
        san: yourMoveStats.san,
        uci: yourMoveStats.uci,
        gamesCount: yourMoveStats.gamesCount,
        wins: yourMoveStats.wins,
        draws: yourMoveStats.draws,
        losses: yourMoveStats.losses,
        scoreShare:
          yourMoveStats.gamesCount === 0
            ? 0
            : (yourMoveStats.wins + 0.5 * yourMoveStats.draws) / yourMoveStats.gamesCount,
      };

      const opportunityScore =
        Math.log(1 + yourMoveStats.gamesCount) *
        Math.log(1 + theirNode.totalGames) *
        (1 - theirAgg.scoreShare);

      out.push({
        yourFenKey,
        yourMove: yourMoveSummary,
        theirFenKey: nextFen,
        theirResponses: topMoves(theirNode, topN),
        theirAggregate: theirAgg,
        opportunityScore,
      });
    }
  }
  out.sort((a, b) => b.opportunityScore - a.opportunityScore);
  return out.slice(0, maxPositions);
}

// ---------------------------------------------------------------------------
// Drift — distribution shift between two buckets for the same player+color
// ---------------------------------------------------------------------------

export interface DriftPosition {
  fenKey: string;
  allTime: {
    totalGames: number;
    scoreShare: number;
    topMove: { san: string; share: number } | null;
  };
  recent: {
    totalGames: number;
    scoreShare: number;
    topMove: { san: string; share: number } | null;
  };
  /** Change in score share (recent - all_time). Positive = doing better recently. */
  scoreDelta: number;
  /** True if top move changed between buckets. */
  topMoveChanged: boolean;
  /** Sum of |freq_recent - freq_all_time| across all moves (move-mix shift, 0-2 range). */
  mixDistance: number;
}

export interface DriftOptions {
  /** Minimum games in BOTH buckets at the position before we surface it. */
  minGamesPerBucket?: number;
  /** Score delta threshold for "material change" (default 0.1 = 10% point swing). */
  minScoreDelta?: number;
  /** Move-mix L1 distance threshold (default 0.4, on 0-2 scale). */
  minMixDistance?: number;
  /** Maximum positions to return. */
  maxPositions?: number;
}

const DEFAULT_DRIFT_MIN_GAMES = 4;
const DEFAULT_DRIFT_MIN_SCORE_DELTA = 0.1;
const DEFAULT_DRIFT_MIN_MIX = 0.4;
const DEFAULT_DRIFT_MAX_POSITIONS = 20;

function bestMove(
  node: SerializedTreeNode,
): { move: SerializedNextMoveStats; share: number } | null {
  let best: SerializedNextMoveStats | null = null;
  for (const m of Object.values(node.children)) {
    if (!best || m.gamesCount > best.gamesCount) best = m;
  }
  if (!best) return null;
  const total = aggregateChildren(node).totalGames;
  return { move: best, share: total === 0 ? 0 : best.gamesCount / total };
}

function moveMixDistance(a: SerializedTreeNode, b: SerializedTreeNode): number {
  const aTotal = aggregateChildren(a).totalGames;
  const bTotal = aggregateChildren(b).totalGames;
  if (aTotal === 0 || bTotal === 0) return 0;
  const uciSet = new Set<string>();
  for (const k of Object.keys(a.children)) uciSet.add(k);
  for (const k of Object.keys(b.children)) uciSet.add(k);
  let dist = 0;
  for (const uci of uciSet) {
    const freqA = (a.children[uci]?.gamesCount ?? 0) / aTotal;
    const freqB = (b.children[uci]?.gamesCount ?? 0) / bTotal;
    dist += Math.abs(freqA - freqB);
  }
  return dist;
}

/**
 * Compare a player's `all_time` repertoire to their `recent_3mo` (or any
 * recent bucket) and surface positions where their behavior changed
 * meaningfully — top move switched, win rate shifted, or move-mix
 * redistributed. Useful prep signal: "in 2024 they played the Catalan,
 * but in their last 3 months they switched to 1.e4".
 */
export function correlateDrift(
  allTime: RepertoireSlice | null,
  recent: RepertoireSlice | null,
  opts: DriftOptions = {},
): DriftPosition[] {
  if (!allTime || !recent) return [];
  const minGames = opts.minGamesPerBucket ?? DEFAULT_DRIFT_MIN_GAMES;
  const minScoreDelta = opts.minScoreDelta ?? DEFAULT_DRIFT_MIN_SCORE_DELTA;
  const minMix = opts.minMixDistance ?? DEFAULT_DRIFT_MIN_MIX;
  const maxPositions = opts.maxPositions ?? DEFAULT_DRIFT_MAX_POSITIONS;

  const out: DriftPosition[] = [];
  for (const [fenKey, allNode] of Object.entries(allTime.tree)) {
    if (allNode.totalGames < minGames) continue;
    const recentNode = recent.tree[fenKey];
    if (!recentNode || recentNode.totalGames < minGames) continue;

    const allAgg = aggregateChildren(allNode);
    const recentAgg = aggregateChildren(recentNode);
    const allBest = bestMove(allNode);
    const recentBest = bestMove(recentNode);
    const topMoveChanged =
      allBest !== null && recentBest !== null && allBest.move.uci !== recentBest.move.uci;
    const mixDistance = moveMixDistance(allNode, recentNode);
    const scoreDelta = recentAgg.scoreShare - allAgg.scoreShare;

    if (Math.abs(scoreDelta) < minScoreDelta && mixDistance < minMix && !topMoveChanged) {
      continue;
    }

    out.push({
      fenKey,
      allTime: {
        totalGames: allAgg.totalGames,
        scoreShare: allAgg.scoreShare,
        topMove: allBest ? { san: allBest.move.san, share: allBest.share } : null,
      },
      recent: {
        totalGames: recentAgg.totalGames,
        scoreShare: recentAgg.scoreShare,
        topMove: recentBest ? { san: recentBest.move.san, share: recentBest.share } : null,
      },
      scoreDelta,
      topMoveChanged,
      mixDistance,
    });
  }
  // Sort by magnitude of change — biggest surprises first.
  out.sort((a, b) => {
    const scoreA = Math.abs(a.scoreDelta) + a.mixDistance + (a.topMoveChanged ? 0.5 : 0);
    const scoreB = Math.abs(b.scoreDelta) + b.mixDistance + (b.topMoveChanged ? 0.5 : 0);
    return scoreB - scoreA;
  });
  return out.slice(0, maxPositions);
}
