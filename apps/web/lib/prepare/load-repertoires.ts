/**
 * Load bucketed `player_repertoires` rows for a (platform, handle) from
 * the games corpus. Companion to apps/workers/src/repertoires/build.ts —
 * that worker writes the trees, we read them.
 *
 * Each row is one (color, depth, time_bucket) slice; one handle has up
 * to 4 buckets × 2 colors = 8 rows at a given depth. We return them as
 * a map keyed by `${color}:${time_bucket}` for cheap lookup by the
 * correlation engine.
 */
import type postgres from 'postgres';
import type { Color } from './types';

export type TimeBucket = 'recent_3mo' | 'recent_12mo' | 'recent_36mo' | 'all_time';

export interface RepertoireSlice {
  color: Color;
  depth: number;
  timeBucket: TimeBucket;
  bucketSince: Date | null;
  bucketUntil: Date | null;
  /** SerializedTree: Record<fenKey, TreeNode> */
  tree: Record<string, SerializedTreeNode>;
}

export interface SerializedTreeNode {
  fenKey: string;
  totalGames: number;
  totalWeighted: number;
  children: Record<string, SerializedNextMoveStats>;
}

export interface SerializedNextMoveStats {
  san: string;
  uci: string;
  fromSquare: string;
  toSquare: string;
  gamesCount: number;
  wins: number;
  draws: number;
  losses: number;
  weightedScore: number;
  lastPlayedAt: string;
  recentGameIds: string[];
}

export type RepertoireMap = Map<string, RepertoireSlice>;

interface DbRow {
  color: Color;
  depth: number;
  time_bucket: TimeBucket;
  bucket_since: Date | string | null;
  bucket_until: Date | string | null;
  tree: unknown;
}

function rowKey(color: Color, bucket: TimeBucket): string {
  return `${color}:${bucket}`;
}

function coerceDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

export async function loadRepertoires(
  sql: postgres.Sql,
  platform: 'lichess' | 'chess.com',
  handle: string,
  depth: number,
): Promise<RepertoireMap> {
  const handleLower = handle.toLowerCase();
  const rows = await sql<DbRow[]>`
    SELECT p.color, p.depth, p.time_bucket, p.bucket_since, p.bucket_until, p.tree
    FROM player_repertoires p
    JOIN handles h ON h.id = p.player_id
    WHERE h.platform = ${platform}
      AND LOWER(h.handle) = ${handleLower}
      AND p.depth = ${depth}
  `;
  const out: RepertoireMap = new Map();
  for (const r of rows) {
    out.set(rowKey(r.color, r.time_bucket), {
      color: r.color,
      depth: r.depth,
      timeBucket: r.time_bucket,
      bucketSince: coerceDate(r.bucket_since),
      bucketUntil: coerceDate(r.bucket_until),
      tree: r.tree as Record<string, SerializedTreeNode>,
    });
  }
  return out;
}

export function getSlice(
  map: RepertoireMap,
  color: Color,
  bucket: TimeBucket,
): RepertoireSlice | null {
  return map.get(rowKey(color, bucket)) ?? null;
}
