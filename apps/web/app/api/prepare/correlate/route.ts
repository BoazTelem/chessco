/**
 * GET /api/prepare/correlate
 *   ?me_platform=&me_handle=&opp_platform=&opp_handle=&depth=12
 *
 * Phase 4 of the player-id pipeline — two-handle bucketed-repertoire
 * diff that powers the Prep Plan product. Loads bucketed
 * `player_repertoires` for both players and runs the correlate engine:
 *
 *   - Color-conditional overlap (your White vs their Black; your Black
 *     vs their White) → opportunity lines you'll actually reach.
 *   - Drift signal: their recent_3mo vs all_time → positions where their
 *     repertoire has shifted, surfaced separately for prep awareness.
 *
 * Requires BOTH handles to have bucketed repertoires built (Phase 2c).
 * If either is missing, returns 404 with a hint to enqueue. The
 * /api/prepare/enqueue endpoint promotes priority so the worker
 * pipeline catches up; revisits after a refresh cycle will succeed.
 *
 * No auth required for v1 — the engine is read-only and the data is
 * derived from public game records. Paywall-gating happens at the UI
 * layer (PrepPlan section) once user→handle linking is in place.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getGamesDb } from '@/lib/games-db';
import {
  correlateDrift,
  correlateOverlap,
  type DriftPosition,
  type OverlapPosition,
} from '@/lib/prepare/correlate';
import {
  getSlice,
  loadRepertoires,
  type RepertoireMap,
  type TimeBucket,
} from '@/lib/prepare/load-repertoires';

const DEFAULT_DEPTH = 12;
const OVERLAP_BUCKET: TimeBucket = 'recent_12mo';
const DRIFT_RECENT_BUCKET: TimeBucket = 'recent_3mo';

const Query = z.object({
  me_platform: z.enum(['lichess', 'chess.com']),
  me_handle: z.string().trim().min(1).max(128),
  opp_platform: z.enum(['lichess', 'chess.com']),
  opp_handle: z.string().trim().min(1).max(128),
  depth: z.coerce.number().int().min(4).max(30).optional(),
  overlap_bucket: z.enum(['recent_3mo', 'recent_12mo', 'recent_36mo', 'all_time']).optional(),
});

interface BucketInfo {
  timeBucket: TimeBucket;
  bucketSince: string | null;
  bucketUntil: string | null;
}

interface CorrelateResponse {
  me: { platform: string; handle: string };
  opp: { platform: string; handle: string };
  depth: number;
  overlapBucket: BucketInfo | null;
  driftBuckets: { baseline: BucketInfo | null; recent: BucketInfo | null };
  /** You as White facing them as Black. */
  asWhite: OverlapPosition[];
  /** You as Black facing them as White. */
  asBlack: OverlapPosition[];
  /** Drift in their White play (all_time vs recent_3mo). */
  driftAsWhite: DriftPosition[];
  /** Drift in their Black play. */
  driftAsBlack: DriftPosition[];
  /** Coverage report — which buckets we found for each handle, so the UI can hint at gaps. */
  meBuckets: string[];
  oppBuckets: string[];
}

function describeBucket(
  map: RepertoireMap,
  color: 'white' | 'black',
  bucket: TimeBucket,
): BucketInfo | null {
  const slice = getSlice(map, color, bucket);
  if (!slice) return null;
  return {
    timeBucket: slice.timeBucket,
    bucketSince: slice.bucketSince?.toISOString() ?? null,
    bucketUntil: slice.bucketUntil?.toISOString() ?? null,
  };
}

function listBuckets(map: RepertoireMap): string[] {
  return [...map.keys()].sort();
}

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const parsed = Query.safeParse({
    me_platform: url.searchParams.get('me_platform'),
    me_handle: url.searchParams.get('me_handle'),
    opp_platform: url.searchParams.get('opp_platform'),
    opp_handle: url.searchParams.get('opp_handle'),
    depth: url.searchParams.get('depth') ?? undefined,
    overlap_bucket: url.searchParams.get('overlap_bucket') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_query' }, { status: 400 });
  }

  const depth = parsed.data.depth ?? DEFAULT_DEPTH;
  const overlapBucket = parsed.data.overlap_bucket ?? OVERLAP_BUCKET;
  const sql = getGamesDb();

  let me: RepertoireMap;
  let opp: RepertoireMap;
  try {
    [me, opp] = await Promise.all([
      loadRepertoires(sql, parsed.data.me_platform, parsed.data.me_handle, depth),
      loadRepertoires(sql, parsed.data.opp_platform, parsed.data.opp_handle, depth),
    ]);
  } catch (err) {
    console.error('[prepare/correlate] load failed:', err);
    return NextResponse.json({ error: 'db_query_failed' }, { status: 502 });
  }

  if (me.size === 0 || opp.size === 0) {
    return NextResponse.json(
      {
        error: 'repertoire_missing',
        missing: {
          me: me.size === 0,
          opp: opp.size === 0,
        },
        hint: 'Both handles must have bucketed repertoires built (Phase 2c). Hit POST /api/prepare/enqueue to promote priority for missing handles; the worker pipeline catches up on the next pass.',
      },
      { status: 404 },
    );
  }

  // Overlap: your white repertoire vs their black, and vice versa.
  // Both directions use the same overlap_bucket — typically recent_12mo
  // so the analysis reflects current preferences, not stale lifetime data.
  const youWhite = getSlice(me, 'white', overlapBucket);
  const themBlack = getSlice(opp, 'black', overlapBucket);
  const youBlack = getSlice(me, 'black', overlapBucket);
  const themWhite = getSlice(opp, 'white', overlapBucket);

  const asWhite = correlateOverlap(youWhite, themBlack);
  const asBlack = correlateOverlap(youBlack, themWhite);

  // Drift on opponent only — comparing their all_time baseline against
  // recent_3mo flags style changes that would otherwise be averaged out.
  // We don't drift-analyze "you" because the user already knows their own play.
  const oppWhiteAll = getSlice(opp, 'white', 'all_time');
  const oppWhiteRecent = getSlice(opp, 'white', DRIFT_RECENT_BUCKET);
  const oppBlackAll = getSlice(opp, 'black', 'all_time');
  const oppBlackRecent = getSlice(opp, 'black', DRIFT_RECENT_BUCKET);

  const driftAsWhite = correlateDrift(oppBlackAll, oppBlackRecent); // their black drift = what you face as white
  const driftAsBlack = correlateDrift(oppWhiteAll, oppWhiteRecent);

  const response: CorrelateResponse = {
    me: { platform: parsed.data.me_platform, handle: parsed.data.me_handle },
    opp: { platform: parsed.data.opp_platform, handle: parsed.data.opp_handle },
    depth,
    overlapBucket:
      describeBucket(me, 'white', overlapBucket) ?? describeBucket(me, 'black', overlapBucket),
    driftBuckets: {
      baseline:
        describeBucket(opp, 'white', 'all_time') ?? describeBucket(opp, 'black', 'all_time'),
      recent:
        describeBucket(opp, 'white', DRIFT_RECENT_BUCKET) ??
        describeBucket(opp, 'black', DRIFT_RECENT_BUCKET),
    },
    asWhite,
    asBlack,
    driftAsWhite,
    driftAsBlack,
    meBuckets: listBuckets(me),
    oppBuckets: listBuckets(opp),
  };

  return NextResponse.json(response, {
    status: 200,
    headers: {
      'Cache-Control': 'private, max-age=300, stale-while-revalidate=900',
    },
  });
}
