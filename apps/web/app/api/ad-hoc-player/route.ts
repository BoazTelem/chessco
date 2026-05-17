/**
 * POST /api/ad-hoc-player — create a custom player entry when FIDE/ICF/etc.
 * search returned nothing. Requires sign-in (user-confirmed quality control;
 * keeps anonymous spam out of the corpus).
 *
 * Body: {
 *   name: string,
 *   country?: string,
 *   rating_estimate?: number,
 *   rating_band?: number,      // half-width; band = [estimate-band, estimate+band]
 *   title?: 'NM'|'CM'|'FM'|'IM'|'GM'|'WCM'|'WFM'|'WIM'|'WGM',
 * }
 * Returns: { id: string }
 *
 * The rating fields close the cold-tail fallback: when an opponent isn't in
 * FIDE/ICF/etc., the user supplies a rating estimate with confidence band so
 * Stage 2 candidate scoring (apps/workers/src/identification/stage2.ts) can
 * still apply rating-band matching. Source is hard-coded to 'user_estimate'
 * here — federation/club imports use other code paths.
 */
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

const TITLES = new Set(['NM', 'CM', 'FM', 'IM', 'GM', 'WCM', 'WFM', 'WIM', 'WGM']);
const MIN_RATING = 100;
const MAX_RATING = 3500;
const MIN_BAND = 25;
const MAX_BAND = 400;

interface ReqBody {
  name?: string;
  country?: string;
  rating_estimate?: number;
  rating_band?: number;
  title?: string;
}

function normalizeName(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[',.()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: ReqBody;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name || name.length < 2 || name.length > 100) {
    return NextResponse.json({ error: 'name is required (2-100 chars)' }, { status: 400 });
  }
  const country = body.country?.trim().toUpperCase() ?? null;

  let ratingEstimate: number | null = null;
  let ratingBandLow: number | null = null;
  let ratingBandHigh: number | null = null;
  if (body.rating_estimate != null) {
    const r = Number(body.rating_estimate);
    if (!Number.isFinite(r) || r < MIN_RATING || r > MAX_RATING) {
      return NextResponse.json(
        { error: `rating_estimate must be ${MIN_RATING}-${MAX_RATING}` },
        { status: 400 },
      );
    }
    ratingEstimate = Math.round(r);

    const bandRaw = body.rating_band ?? 100;
    const band = Number(bandRaw);
    if (!Number.isFinite(band) || band < MIN_BAND || band > MAX_BAND) {
      return NextResponse.json(
        { error: `rating_band must be ${MIN_BAND}-${MAX_BAND}` },
        { status: 400 },
      );
    }
    ratingBandLow = Math.max(MIN_RATING, ratingEstimate - Math.round(band));
    ratingBandHigh = Math.min(MAX_RATING, ratingEstimate + Math.round(band));
  }

  let title: string | null = null;
  if (body.title) {
    const t = body.title.trim().toUpperCase();
    if (!TITLES.has(t)) {
      return NextResponse.json(
        { error: `title must be one of ${[...TITLES].join(', ')}` },
        { status: 400 },
      );
    }
    title = t;
  }

  // Auth: must be signed in. We check via the cookie-bound server client.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'sign-in required to track a player' }, { status: 401 });
  }

  // Insert with the service-role client so we bypass any future RLS we add.
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('ad_hoc_players')
    .insert({
      name,
      name_normalized: normalizeName(name),
      country,
      created_by: user.id,
      rating_estimate: ratingEstimate,
      rating_band_low: ratingBandLow,
      rating_band_high: ratingBandHigh,
      rating_source: ratingEstimate != null ? 'user_estimate' : null,
      title,
    })
    .select('id')
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? 'failed to create ad-hoc player' },
      { status: 500 },
    );
  }

  return NextResponse.json({ id: (data as { id: string }).id });
}
