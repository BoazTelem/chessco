/**
 * POST /api/scout/delist — right-to-delist endpoint (spec §6 privacy).
 *
 * Body: { player_id: uuid, reason?: string }
 *
 * Authorization rules (in order):
 *   1. Caller must be authenticated.
 *   2. Either:
 *      a) the player's `profile_id` matches the caller's profile id, OR
 *      b) the caller is a super-admin per requireSuperAdmin().
 *   3. Player must not already be delisted (re-requests are no-ops with 200).
 *
 * Effect:
 *   - Sets `players.delisted_at = NOW()` and `players.delist_reason = reason`.
 *   - The downstream aggregate recompute job clears the embedding and
 *     drops the player from /scout indexes within minutes (Phase 2 SLA: 5
 *     min). Until then, /p/[id] returns 404 because the read path filters
 *     on delisted_at IS NULL.
 *   - Writes a row to audit_logs so the action is traceable.
 *
 * The endpoint is idempotent: replays return 200 with `already_delisted: true`.
 */
import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getUser, isSuperAdminEmail } from '@/lib/auth';

interface ReqBody {
  player_id?: string;
  reason?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request) {
  let body: ReqBody;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const playerId = body.player_id;
  if (!playerId || !UUID_RE.test(playerId)) {
    return NextResponse.json({ error: 'player_id_required' }, { status: 400 });
  }
  // Spec discipline §3 §17: reason is free text but capped to a short
  // string so the audit log doesn't accumulate unbounded user input.
  const reason = (body.reason ?? '').slice(0, 500) || null;

  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const supabase = createAdminClient();

  type PlayerRow = {
    id: string;
    profile_id: string | null;
    delisted_at: string | null;
  };
  const { data: player, error: fetchErr } = await supabase
    .from('players')
    .select('id, profile_id, delisted_at')
    .eq('id', playerId)
    .maybeSingle<PlayerRow>();

  if (fetchErr) {
    return NextResponse.json({ error: 'lookup_failed', detail: fetchErr.message }, { status: 500 });
  }
  if (!player) {
    return NextResponse.json({ error: 'player_not_found' }, { status: 404 });
  }

  const isOwner = player.profile_id !== null && player.profile_id === user.id;
  const isAdmin = isSuperAdminEmail(user.email);
  if (!isOwner && !isAdmin) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  if (player.delisted_at !== null) {
    return NextResponse.json({
      already_delisted: true,
      delisted_at: player.delisted_at,
    });
  }

  const nowIso = new Date().toISOString();
  const { error: updErr } = await supabase
    .from('players')
    .update({
      delisted_at: nowIso,
      delist_reason: reason,
      embedding: null, // wipe vector eagerly; aggregates rebuild later
      updated_at: nowIso,
    })
    .eq('id', playerId);

  if (updErr) {
    return NextResponse.json({ error: 'update_failed', detail: updErr.message }, { status: 500 });
  }

  // Best-effort audit. Failures here don't fail the request; the primary
  // delist succeeded and a missed audit row is recoverable from logs.
  await supabase
    .from('audit_logs')
    .insert({
      actor_type: isAdmin && !isOwner ? 'admin' : 'user',
      actor_id: user.id,
      action: 'player.delist',
      target_type: 'player',
      target_id: playerId,
      after: { delisted_at: nowIso, via: isAdmin && !isOwner ? 'admin' : 'self' },
      reason,
    })
    .then(
      () => undefined,
      () => undefined,
    );

  return NextResponse.json({
    delisted: true,
    player_id: playerId,
    delisted_at: nowIso,
  });
}
