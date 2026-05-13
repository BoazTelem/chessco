import type { Filters, GameRecord, NextMoveStats, TimeClass, Tree, TreeNode } from './types';
import { MAX_SAMPLE_GAMES_PER_MOVE } from './types';
import { recencyWeight } from './recency';

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

export function windowBounds(filters: Filters, now: Date): { since: Date; until: Date } {
  if (filters.window === 'custom') {
    return {
      since: filters.customSince ?? new Date(0),
      until: filters.customUntil ?? now,
    };
  }
  if (filters.window === 'all') {
    return { since: new Date(0), until: now };
  }
  return { since: new Date(now.getTime() - filters.window * MS_PER_YEAR), until: now };
}

function ensureNode(tree: Tree, fenKey: string): TreeNode {
  let node = tree.get(fenKey);
  if (!node) {
    node = { fenKey, totalGames: 0, totalWeighted: 0, children: new Map() };
    tree.set(fenKey, node);
  }
  return node;
}

function uciToSquares(uci: string): { from: string; to: string } {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4) };
}

function applyGameToTree(tree: Tree, game: GameRecord, weight: number, maxPly: number): void {
  const limit = Math.min(game.movesSan.length, maxPly * 2);
  for (let i = 0; i < limit; i += 1) {
    const fenKey = game.fensBefore[i];
    const san = game.movesSan[i];
    const uci = game.movesUci[i];
    if (!fenKey || !san || !uci) break;
    const node = ensureNode(tree, fenKey);
    node.totalGames += 1;
    node.totalWeighted += weight;
    let move = node.children.get(uci);
    if (!move) {
      const { from, to } = uciToSquares(uci);
      move = {
        san,
        uci,
        fromSquare: from,
        toSquare: to,
        gamesCount: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        weightedScore: 0,
        lastPlayedAt: game.playedAt,
        recentGameIds: [],
      };
      node.children.set(uci, move);
    }
    move.gamesCount += 1;
    move.weightedScore += weight;
    if (game.result === 'win') move.wins += 1;
    else if (game.result === 'draw') move.draws += 1;
    else move.losses += 1;
    if (game.playedAt > move.lastPlayedAt) move.lastPlayedAt = game.playedAt;
    addRecentGameId(move, game);
  }
}

function addRecentGameId(move: NextMoveStats, game: GameRecord): void {
  // Both fetchers yield most-recent-first, so keeping the first N seen
  // captures the most recent samples without an extra sort.
  if (move.recentGameIds.length < MAX_SAMPLE_GAMES_PER_MOVE) {
    move.recentGameIds.push(game.id);
  }
}

export interface BuildTreeOptions {
  filters: Filters;
  /** Max plies-deep to record (counts only the target color's moves). Default 30. */
  maxPly?: number;
  /** Inject a stable "now" for testing. */
  now?: Date;
}

export function gamePassesFilters(game: GameRecord, filters: Filters, now: Date): boolean {
  if (game.playerColor !== filters.color) return false;
  if (filters.timeClasses.size > 0) {
    if (game.timeClass === 'unknown') return false;
    if (!filters.timeClasses.has(game.timeClass)) return false;
  }
  const { since, until } = windowBounds(filters, now);
  if (game.playedAt < since || game.playedAt > until) return false;
  return true;
}

export function buildTree(games: GameRecord[], opts: BuildTreeOptions): Tree {
  const tree: Tree = new Map();
  const now = opts.now ?? new Date();
  const maxPly = opts.maxPly ?? 30;
  for (const game of games) {
    if (!gamePassesFilters(game, opts.filters, now)) continue;
    const weight = recencyWeight(game.playedAt, now);
    applyGameToTree(tree, game, weight, maxPly);
  }
  return tree;
}

export function topMoves(node: TreeNode, n: number): NextMoveStats[] {
  return [...node.children.values()].sort((a, b) => b.weightedScore - a.weightedScore).slice(0, n);
}

export interface TimeClassCounts {
  bullet: number;
  blitz: number;
  rapid: number;
  classical: number;
  unknown: number;
  total: number;
}

export function countByTimeClass(games: GameRecord[]): TimeClassCounts {
  const counts: TimeClassCounts = {
    bullet: 0,
    blitz: 0,
    rapid: 0,
    classical: 0,
    unknown: 0,
    total: 0,
  };
  for (const g of games) {
    counts.total += 1;
    const key: TimeClass = g.timeClass;
    counts[key] += 1;
  }
  return counts;
}
