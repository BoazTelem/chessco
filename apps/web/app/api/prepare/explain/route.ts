/**
 * POST /api/prepare/explain — LLM explainer for the Phase 4 correlation
 * engine output. Phase 5 of the player-id pipeline.
 *
 * Accepts a correlation digest (the response shape of
 * /api/prepare/correlate) and returns a structured "prep brief":
 * headline + 3 concrete lines to study + drift callouts.
 *
 * The client POSTs the correlate response directly to avoid a second
 * round trip — the engine already has the full diff JSON in hand, and
 * piping it back lets the model see exactly what the user sees.
 *
 * Fail-soft: if the provider key is missing or the model returns
 * garbage, returns 200 with `available: false` so the UI degrades to
 * the raw correlation panel without surfacing a scary error.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { generateExplanation, type CorrelateDigest } from '@/lib/prepare/explain';
import { getProseProvider } from '@/lib/scout/llm-providers';
import { createClient } from '@/lib/supabase/server';

const MAX_BYTES = 256 * 1024;
const MAX_OVERLAP_POSITIONS = 25;
const MAX_DRIFT_POSITIONS = 20;

const TopMoveSchema = z.object({
  san: z.string(),
  uci: z.string().optional(),
  gamesCount: z.number(),
  scoreShare: z.number(),
});

const OverlapSchema = z.object({
  yourMove: z.object({ san: z.string(), gamesCount: z.number() }),
  theirResponses: z.array(TopMoveSchema).max(5),
  theirAggregate: z.object({ totalGames: z.number(), scoreShare: z.number() }),
  opportunityScore: z.number(),
});

const DriftSchema = z.object({
  fenKey: z.string(),
  allTime: z.object({
    totalGames: z.number(),
    scoreShare: z.number(),
    topMove: z.object({ san: z.string(), share: z.number() }).nullable(),
  }),
  recent: z.object({
    totalGames: z.number(),
    scoreShare: z.number(),
    topMove: z.object({ san: z.string(), share: z.number() }).nullable(),
  }),
  scoreDelta: z.number(),
  topMoveChanged: z.boolean(),
  mixDistance: z.number(),
});

const Input = z.object({
  me: z.object({ platform: z.string(), handle: z.string() }),
  opp: z.object({ platform: z.string(), handle: z.string() }),
  depth: z.number(),
  overlapBucket: z.object({ timeBucket: z.string() }).nullable(),
  driftBuckets: z.object({
    baseline: z.object({ timeBucket: z.string() }).nullable(),
    recent: z.object({ timeBucket: z.string() }).nullable(),
  }),
  asWhite: z.array(OverlapSchema).max(MAX_OVERLAP_POSITIONS),
  asBlack: z.array(OverlapSchema).max(MAX_OVERLAP_POSITIONS),
  driftAsWhite: z.array(DriftSchema).max(MAX_DRIFT_POSITIONS),
  driftAsBlack: z.array(DriftSchema).max(MAX_DRIFT_POSITIONS),
});

export async function POST(req: Request): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const contentLengthHeader = req.headers.get('content-length');
  if (contentLengthHeader) {
    const length = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(length) && length > MAX_BYTES) {
      return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
    }
  }

  let body: z.infer<typeof Input>;
  try {
    const rawBody = await req.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BYTES) {
      return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
    }
    body = Input.parse(JSON.parse(rawBody));
  } catch (err) {
    const msg =
      err instanceof z.ZodError ? (err.issues[0]?.message ?? 'invalid input') : 'invalid JSON';
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const provider = getProseProvider();
  if (!provider) {
    return NextResponse.json(
      { available: false, reason: 'no_provider_configured' },
      { status: 200 },
    );
  }

  try {
    const result = await generateExplanation(body as CorrelateDigest, provider);
    return NextResponse.json(
      { available: true, ...result },
      {
        status: 200,
        headers: {
          // Same TTL as /correlate (5 min fresh, 15 min stale). The cost
          // per call is real (~$0.001) so caching matters.
          'Cache-Control': 'private, max-age=300, stale-while-revalidate=900',
        },
      },
    );
  } catch (err) {
    console.error('[prepare/explain] LLM call failed:', err);
    return NextResponse.json(
      {
        available: false,
        reason: 'llm_failure',
        message: err instanceof Error ? err.message : 'unknown error',
      },
      { status: 200 },
    );
  }
}
