/**
 * POST /api/ad-hoc-player — create a custom player entry when FIDE/ICF/etc.
 * search returned nothing. Requires sign-in (user-confirmed quality control;
 * keeps anonymous spam out of the corpus).
 *
 * Body: { name: string, country?: string }
 * Returns: { id: string }
 */
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

interface ReqBody {
  name?: string;
  country?: string;
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
