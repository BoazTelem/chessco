/**
 * POST /api/candidate/{id}/feedback — confirm or reject a match candidate.
 *
 * Closes Stage 1 ("WIN") of the Scout flow: when a user marks "✓ This is
 * them", the candidate's user_confirmed flips to true, and the candidate
 * surfaces on the player profile's "Known online accounts" section for
 * everyone who searches that player next.
 *
 * Auth required — anonymous feedback would poison the corpus. The current
 * row uses a single shared boolean (last-writer-wins); per-user provenance
 * is a follow-up if the feedback ever conflicts in practice.
 *
 * Body: { confirmed: true | false | null }
 *   true   — user says this IS the right account
 *   false  — user says this is the WRONG account
 *   null   — user undoes their previous feedback
 */
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

interface ReqBody {
  confirmed: boolean | null;
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

  if (body.confirmed !== true && body.confirmed !== false && body.confirmed !== null) {
    return NextResponse.json({ error: 'confirmed must be true, false, or null' }, { status: 400 });
  }

  // Auth: must be signed in.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'sign-in required' }, { status: 401 });
  }

  // Service-role client to update (bypasses any RLS; we already authed above).
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('identification_candidates')
    .update({ user_confirmed: body.confirmed })
    .eq('id', candidateId)
    .select('id, user_confirmed')
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? 'failed to update candidate' },
      { status: 500 },
    );
  }

  return NextResponse.json(data);
}
