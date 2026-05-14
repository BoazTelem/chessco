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
    .select('id, user_confirmed, user_feedback')
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? 'failed to update candidate' },
      { status: 500 },
    );
  }

  return NextResponse.json(data);
}
