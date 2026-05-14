import postgres from 'postgres';
import type { Color, Platform, SerializedTree } from './types';

const DEFAULT_DEPTH = 12;
const BUCKET_PREFERENCE = ['recent_36mo', 'recent_12mo', 'all_time'] as const;

/**
 * Load a serialized opening tree for one (handle, color) from the games
 * corpus. Walks the bucket-preference list and returns the first match.
 * Returns null when no repertoire row exists yet.
 */
export async function loadRepertoireTree(args: {
  games: postgres.Sql;
  platform: Platform;
  handleNormalized: string;
  color: Color;
  depth?: number;
}): Promise<SerializedTree | null> {
  const { games, platform, handleNormalized, color } = args;
  const depth = args.depth ?? DEFAULT_DEPTH;

  for (const bucket of BUCKET_PREFERENCE) {
    const rows = await games<Array<{ tree: SerializedTree }>>`
      SELECT pr.tree::jsonb AS tree
      FROM player_repertoires pr
      JOIN handles h ON h.id = pr.player_id
      WHERE h.platform = ${platform}
        AND LOWER(h.handle) = ${handleNormalized}
        AND pr.color = ${color}
        AND pr.depth = ${depth}
        AND pr.time_bucket = ${bucket}
      LIMIT 1
    `;
    if (rows.length > 0) return rows[0]!.tree;
  }
  return null;
}
