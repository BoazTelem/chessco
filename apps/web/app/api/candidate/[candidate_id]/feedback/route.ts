/**
 * POST /api/candidate/{id}/feedback - submit match-quality feedback.
 *
 * Feedback levels:
 *   correct            - 100% right
 *   probably_correct   - not sure, feels right
 *   probably_wrong     - not sure, feels wrong
 *   wrong              - 100% wrong
 *
 * Auth required - anonymous feedback would poison the corpus.
 *
 * Body: { feedback: CandidateFeedback | null }
 *
 * Back-compat: { confirmed: true | false | null } is still accepted.
 */
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

type CandidateFeedback = 'correct' | 'probably_correct' | 'probably_wrong' | 'wrong';

interface ReqBody {
  feedback?: CandidateFeedback | null;
  confirmed?: boolean | null;
}

const FEEDBACK_VALUES = new Set<CandidateFeedback>([
  'correct',
  'probably_correct',
  'probably_wrong',
  'wrong',
]);

function normalizeBody(body: ReqBody): CandidateFeedback | null | undefined {
  if ('feedback' in body) {
    if (body.feedback === null) return null;
    return body.feedback;
  }
  if ('confirmed' in body) {
    if (body.confirmed === true) return 'correct';
    if (body.confirmed === false) return 'wrong';
    if (body.confirmed === null) return null;
  }
  return undefined;
}

function publicConfirmed(feedback: CandidateFeedback | null): boolean | null {
  if (feedback === 'correct') return true;
  if (feedback === 'wrong') return false;
  return null;
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ candidate_id: string }> },
): Promise<NextResponse> {
  const { candidate_id } = await ctx.params;
  const candidateId = Number.parseInt(candidate_id, 10);
  if (!Number.isFinite(candidateId)) {
    return NextResponse.json({ error: 'invalid candidate_id' }, { status: 400 });
  }

  let body: ReqBody;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const feedback = normalizeBody(body);
  if (feedback === undefined || (feedback !== null && !FEEDBACK_VALUES.has(feedback))) {
    return NextResponse.json(
      {
        error: 'feedback must be correct, probably_correct, probably_wrong, wrong, or null',
      },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'sign-in required' }, { status: 401 });
  }

  const admin = createAdminClient();
  if (feedback === null) {
    await admin
      .from('identification_candidate_feedback')
      .delete()
      .eq('candidate_id', candidateId)
      .eq('user_id', user.id);
  } else {
    const { error: feedbackErr } = await admin.from('identification_candidate_feedback').upsert(
      {
        candidate_id: candidateId,
        user_id: user.id,
        feedback,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'candidate_id,user_id' },
    );
    if (feedbackErr) {
      return NextResponse.json({ error: feedbackErr.message }, { status: 500 });
    }
  }

  const { data, error } = await admin
    .from('identification_candidates')
    .update({
      user_feedback: feedback,
      user_feedback_by: feedback === null ? null : user.id,
      user_feedback_at: feedback === null ? null : new Date().toISOString(),
      user_confirmed: publicConfirmed(feedback),
    })
    .eq('id', candidateId)
    .select('id, user_confirmed, user_feedback, ad_hoc_player_id, platform, handle')
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? 'failed to update candidate' },
      { status: 500 },
    );
  }

  // Back-feed loop for ad-hoc anchors: when a user marks a candidate
  // 'correct' on a query anchored to an ad_hoc_player, persist the
  // (ad_hoc_player_id, platform, handle, confirmed_by) tuple so the
  // nightly promote-ad-hoc worker can promote anchors with ≥2 distinct
  // confirmations. Best-effort — failures here don't roll back the
  // candidate update (the user's primary action already succeeded).
  const candRow = data as {
    id: number;
    user_confirmed: boolean | null;
    user_feedback: CandidateFeedback | null;
    ad_hoc_player_id: string | null;
    platform: 'lichess' | 'chess.com';
    handle: string;
  };
  if (feedback === 'correct' && candRow.ad_hoc_player_id) {
    await recordAdHocConfirmation(
      admin,
      candRow.ad_hoc_player_id,
      candRow.platform,
      candRow.handle,
      user.id,
      candidateId,
    );
  }

  return NextResponse.json({
    id: candRow.id,
    user_confirmed: candRow.user_confirmed,
    user_feedback: candRow.user_feedback,
  });
}

/**
 * Insert a confirmation tuple and refresh the denormalized counters on the
 * ad_hoc_players row. UNIQUE (ad_hoc_player_id, platform, handle,
 * confirmed_by) means re-confirmations from the same user are no-ops (just
 * silently swallowed by the ON CONFLICT clause). The DISTINCT-confirmer
 * count is recomputed from the join table to stay authoritative even if a
 * prior counter row was modified by hand.
 */
async function recordAdHocConfirmation(
  admin: ReturnType<typeof createAdminClient>,
  adHocPlayerId: string,
  platform: 'lichess' | 'chess.com',
  handle: string,
  userId: string,
  candidateId: number,
): Promise<void> {
  const now = new Date().toISOString();
  const { error: insertErr } = await admin.from('ad_hoc_player_handles').upsert(
    {
      ad_hoc_player_id: adHocPlayerId,
      platform,
      handle,
      confirmed_by: userId,
      candidate_id: candidateId,
      confirmed_at: now,
    },
    { onConflict: 'ad_hoc_player_id,platform,handle,confirmed_by', ignoreDuplicates: true },
  );
  if (insertErr) {
    console.warn('[ad-hoc back-feed] handle insert failed:', insertErr.message);
    return;
  }

  // Recompute distinct confirmer count across all (platform, handle) pairs
  // for this ad-hoc anchor. Single user → multiple handles still counts as
  // one confirmer; multiple users → same handle counts as multiple
  // confirmers (the value we want for promotion eligibility).
  const { data: confirmRows, error: countErr } = await admin
    .from('ad_hoc_player_handles')
    .select('confirmed_by')
    .eq('ad_hoc_player_id', adHocPlayerId);
  if (countErr) {
    console.warn('[ad-hoc back-feed] count query failed:', countErr.message);
    return;
  }
  const distinctConfirmers = new Set(
    (confirmRows ?? []).map((r) => (r as { confirmed_by: string }).confirmed_by),
  ).size;

  await admin
    .from('ad_hoc_players')
    .update({
      confirmed_match_count: distinctConfirmers,
      last_confirmed_at: now,
    })
    .eq('id', adHocPlayerId);
}
