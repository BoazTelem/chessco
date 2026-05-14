import type { SerializedNextMove, SerializedTree } from './types';

export function mergeTrees(trees: SerializedTree[]): SerializedTree {
  if (trees.length === 0) return {};
  if (trees.length === 1) return trees[0]!;

  const merged: SerializedTree = {};

  for (const tree of trees) {
    for (const [fenKey, node] of Object.entries(tree)) {
      const existing = merged[fenKey];
      if (!existing) {
        merged[fenKey] = {
          fenKey: node.fenKey,
          totalGames: node.totalGames,
          totalWeighted: node.totalWeighted,
          children: { ...node.children },
        };
        continue;
      }
      existing.totalGames += node.totalGames;
      existing.totalWeighted += node.totalWeighted;
      mergeChildren(existing.children, node.children);
    }
  }

  return merged;
}

function mergeChildren(
  into: Record<string, SerializedNextMove>,
  from: Record<string, SerializedNextMove>,
): void {
  for (const [uci, move] of Object.entries(from)) {
    const existing = into[uci];
    if (!existing) {
      into[uci] = { ...move, recentGameIds: [...move.recentGameIds] };
      continue;
    }
    existing.gamesCount += move.gamesCount;
    existing.wins += move.wins;
    existing.draws += move.draws;
    existing.losses += move.losses;
    existing.weightedScore += move.weightedScore;
    if (move.lastPlayedAt > existing.lastPlayedAt) {
      existing.lastPlayedAt = move.lastPlayedAt;
    }
  }
}
