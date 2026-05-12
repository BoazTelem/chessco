/**
 * POST /api/identify — name-anchored Stage 2 OR sample-game Stage 3.
 *
 * Body (one of):
 *   { federation_player_id: uuid }
 *   { name: string, country?: string, fide_rating?: number, title?: string }
 *   { sample_pgn: string }    // Stage 3 — paste 1+ PGNs of the target
 *
 * Stage 3 takes 1-3s end-to-end (parse PGN + extract features + cosine
 * across ~1,400 cached fingerprints). Stage 2 cached: <1s. Both run
 * synchronously here — async polling moves in when corpus growth pushes
 * Stage 3 past ~5s.
 */
import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { parsePgnToGameRows } from '@/lib/scout/pgn';
import { rankBySampleGames, type Stage3Match } from '@/lib/scout/stage3';
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
  /** Stage 3: paste of 1+ PGN(s) — triggers stylometric matching. */
  sample_pgn?: string;
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

  if (!body.federation_player_id && !body.name && !body.sample_pgn) {
    return NextResponse.json(
      { error: 'must provide federation_player_id, name, or sample_pgn' },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();

  // -- Stage 3 branch: sample-game stylometric matching ---------------------
  if (body.sample_pgn) {
    return handleSamplePgn(supabase, body.sample_pgn);
  }

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

async function handleSamplePgn(
  supabase: ReturnType<typeof createAdminClient>,
  sample_pgn: string,
): Promise<NextResponse> {
  const games = parsePgnToGameRows(sample_pgn);
  if (games.length === 0) {
    return NextResponse.json(
      { error: 'no valid games parsed from sample_pgn — check the PGN format' },
      { status: 400 },
    );
  }

  // Insert query row first so we have an id even on error.
  const { data: queryRow, error: insertErr } = await supabase
    .from('identification_queries')
    .insert({
      query_payload: { games_pasted: games.length },
      input_method: 'sample_game',
      sample_pgn,
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

  let matches: Stage3Match[];
  try {
    const result = await rankBySampleGames(games, { topK: 15, minGamesWindow: 10 });
    matches = result.matches;
  } catch (err) {
    await supabase.from('identification_queries').update({ status: 'failed' }).eq('id', queryId);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'stage 3 failed' },
      { status: 500 },
    );
  }

  if (matches.length > 0) {
    const rows = matches.map((m, i) => ({
      query_id: queryId,
      rank: i + 1,
      platform: m.platform,
      handle: m.handle,
      confidence_label:
        m.combined_score >= 0.7 ? 'high' : m.combined_score >= 0.5 ? 'medium' : ('low' as const),
      combined_score: m.combined_score,
      style_score: m.combined_score,
      evidence: {
        components: m.components,
        games_window: m.games_window,
        reasons: [
          `eco-W ${(m.components.eco_white * 100).toFixed(0)}%`,
          `eco-B ${(m.components.eco_black * 100).toFixed(0)}%`,
          `time-class ${(m.components.time_class * 100).toFixed(0)}%`,
          `opp-rating ${(m.components.opp_rating * 100).toFixed(0)}%`,
        ],
        country: null,
        title: null,
        ratings: { bullet: null, blitz: null, rapid: null, classical: null },
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

  return NextResponse.json({
    query_id: queryId,
    candidate_count: matches.length,
    games_parsed: games.length,
  });
}
