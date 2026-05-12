/**
 * POST /api/identify — Stage 2 identification endpoint.
 *
 * Body (one of):
 *   { federation_player_id: uuid }   // anchor to a federation player
 *   { name: string, country?: string, fide_rating?: number, title?: string }
 *
 * Behavior:
 *   1. Insert an identification_queries row (status='pending')
 *   2. Run Stage 2 cached match against platform_players
 *   3. Insert top N candidates as identification_candidates
 *   4. Mark query status='ready'
 *   5. Return { query_id }
 *
 * Stage 2 cached runs in <1s typically; we do it synchronously here.
 * Stage 3 (sample-game stylometric, W5) will move to Inngest + polling.
 */
import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { runStage2Cached } from '@/lib/scout/stage2';

interface FederationPlayerLite {
  id: string;
  name: string;
  country: string | null;
  birth_year: number | null;
  title: string | null;
  rating_standard: number | null;
}

interface ReqBody {
  federation_player_id?: string;
  name?: string;
  country?: string;
  fide_rating?: number;
  title?: string;
}

const MAX_CANDIDATES_PERSISTED = 15;

function confidenceLabel(conf: number): 'high' | 'medium' | 'low' {
  if (conf >= 0.8) return 'high';
  if (conf >= 0.6) return 'medium';
  return 'low';
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: ReqBody;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  if (!body.federation_player_id && !body.name) {
    return NextResponse.json(
      { error: 'must provide federation_player_id or name' },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();

  // ---- Resolve federation_player if id provided -----------------------
  let federationPlayer: FederationPlayerLite | null = null;
  if (body.federation_player_id) {
    const { data, error } = await supabase
      .from('federation_players')
      .select('id, name, country, birth_year, title, rating_standard')
      .eq('id', body.federation_player_id)
      .maybeSingle();
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({ error: 'federation_player not found' }, { status: 404 });
    }
    federationPlayer = data as FederationPlayerLite;
  }

  const stage2Input = {
    name: federationPlayer?.name ?? body.name ?? '',
    country: federationPlayer?.country ?? body.country ?? null,
    fide_rating: federationPlayer?.rating_standard ?? body.fide_rating ?? null,
    title: federationPlayer?.title ?? body.title ?? null,
    federation_player_id: federationPlayer?.id ?? null,
  };

  // ---- Insert query row -----------------------------------------------
  const queryPayload = {
    federation_player_id: federationPlayer?.id ?? null,
    name: stage2Input.name,
    country: stage2Input.country,
    fide_rating: stage2Input.fide_rating,
    title: stage2Input.title,
  };

  const { data: queryRow, error: insertErr } = await supabase
    .from('identification_queries')
    .insert({
      query_payload: queryPayload,
      input_method: 'name',
      status: 'pending',
    })
    .select('id')
    .single();
  if (insertErr || !queryRow) {
    return NextResponse.json(
      { error: insertErr?.message ?? 'failed to create query' },
      { status: 500 },
    );
  }
  const queryId = (queryRow as { id: string }).id;

  // ---- Run Stage 2 ----------------------------------------------------
  let candidates: Awaited<ReturnType<typeof runStage2Cached>>;
  try {
    candidates = await runStage2Cached(stage2Input);
  } catch (err) {
    await supabase.from('identification_queries').update({ status: 'failed' }).eq('id', queryId);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'stage 2 failed' },
      { status: 500 },
    );
  }

  // ---- Persist top N as candidates ------------------------------------
  const persisted = candidates.slice(0, MAX_CANDIDATES_PERSISTED);
  if (persisted.length > 0) {
    const rows = persisted.map((c, i) => ({
      query_id: queryId,
      rank: i + 1,
      federation_player_id: federationPlayer?.id ?? null,
      platform: c.platform,
      handle: c.handle,
      confidence_label: confidenceLabel(c.confidence),
      combined_score: c.confidence,
      handle_score: c.confidence,
      evidence: {
        reasons: c.reasons,
        country: c.country,
        title: c.title,
        ratings: c.ratings,
      },
    }));
    const { error: candErr } = await supabase.from('identification_candidates').insert(rows);
    if (candErr) {
      return NextResponse.json({ error: candErr.message }, { status: 500 });
    }
  }

  await supabase
    .from('identification_queries')
    .update({ status: 'ready', completed_at: new Date().toISOString() })
    .eq('id', queryId);

  return NextResponse.json({ query_id: queryId, candidate_count: persisted.length });
}
