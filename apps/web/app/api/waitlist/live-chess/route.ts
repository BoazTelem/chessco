/**
 * POST /api/waitlist/live-chess — capture interest in Live Chess, the
 * mutual-webcam-required matchmaking surface (and the webcam companion for
 * chess.com games). Engineering ships later; the /benchmarks "How it works"
 * page introduces the feature with this waitlist as the only CTA today.
 *
 * Mirrors /api/waitlist/position-practice: insert into marketplace_waitlist
 * (migration 0019), duplicate (email, time_class) is idempotent success.
 *
 * Body: { email: string, time_class?: 'bullet'|'blitz'|'rapid'|'classical'|'any', notes?: string }
 */
import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

interface ReqBody {
  email?: string;
  time_class?: string;
  notes?: string;
}

const ALLOWED_TIME_CLASSES = new Set(['bullet', 'blitz', 'rapid', 'classical', 'any']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UNIQUE_VIOLATION = '23505';

export async function POST(req: Request): Promise<NextResponse> {
  let body: ReqBody;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase() ?? '';
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: 'please enter a valid email' }, { status: 400 });
  }

  const timeClass = body.time_class ?? 'any';
  if (!ALLOWED_TIME_CLASSES.has(timeClass)) {
    return NextResponse.json({ error: 'invalid time class' }, { status: 400 });
  }

  const notes = body.notes?.trim().slice(0, 500) || null;

  const admin = createAdminClient();
  const { error } = await admin.from('marketplace_waitlist').insert({
    email,
    time_class: timeClass,
    notes,
    source: 'live_chess',
  });

  if (error && error.code !== UNIQUE_VIOLATION) {
    return NextResponse.json({ error: 'failed to join waitlist — try again' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
