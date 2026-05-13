/**
 * POST /api/prepare/verify — confirm a chess.com or Lichess handle exists
 * before sending the user to /prepare/[platform]/[handle]. Reuses the
 * lazy-probe primitives from lib/scout/lazy-probe so cached `platform_players`
 * rows get warmed up for downstream Scout queries.
 *
 * Body: { handle: string, platform: 'lichess' | 'chess.com' }
 * Returns 200 { exists: true, handle, ratings? } on success,
 *         404 { exists: false } when the platform returns no such user.
 */
import { NextResponse } from 'next/server';
import { probeChesscomOne, probeLichess, upsertProbeHits } from '@/lib/scout/lazy-probe';
import { createAdminClient } from '@/lib/supabase/admin';

interface ReqBody {
  handle?: string;
  platform?: string;
}

const HANDLE_RE = /^[A-Za-z0-9_-]{2,30}$/;
const ALLOWED_PLATFORMS = new Set(['lichess', 'chess.com']);

export async function POST(req: Request): Promise<NextResponse> {
  let body: ReqBody;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const handle = body.handle?.trim() ?? '';
  const platform = body.platform?.trim() ?? '';

  if (!HANDLE_RE.test(handle)) {
    return NextResponse.json(
      { error: 'username must be 2–30 chars (letters, digits, _ or -)' },
      { status: 400 },
    );
  }
  if (!ALLOWED_PLATFORMS.has(platform)) {
    return NextResponse.json(
      { error: "platform must be 'lichess' or 'chess.com'" },
      { status: 400 },
    );
  }

  const hit =
    platform === 'chess.com'
      ? await probeChesscomOne(handle)
      : ((await probeLichess([handle]))[0] ?? null);

  if (!hit) {
    return NextResponse.json({ exists: false }, { status: 404 });
  }

  // Warm the cache for future Scout queries. Best-effort — verify shouldn't
  // fail if the upsert hiccups.
  try {
    await upsertProbeHits(createAdminClient(), [hit]);
  } catch {
    // intentionally swallowed
  }

  return NextResponse.json({
    exists: true,
    handle: hit.handle,
    claimed_name: hit.claimed_name,
    country: hit.country,
    title: hit.title,
    ratings: {
      bullet: hit.rating_bullet,
      blitz: hit.rating_blitz,
      rapid: hit.rating_rapid,
      classical: hit.rating_classical,
    },
  });
}
