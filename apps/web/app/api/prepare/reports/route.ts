/**
 * POST /api/prepare/reports — create or reuse a Personalized Leaks
 * report for a (platform, handle) target. Idempotent per
 * (profile, platform, handle_normalized) via the partial unique index
 * on prep_reports.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { getPracticeDb } from '@/lib/practice/db';

const Input = z.object({
  platform: z.enum(['lichess', 'chess.com']),
  handle: z.string().trim().min(1).max(128),
});

export async function POST(req: Request): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  let body: z.infer<typeof Input>;
  try {
    body = Input.parse(await req.json());
  } catch (err) {
    const msg =
      err instanceof z.ZodError ? (err.issues[0]?.message ?? 'invalid input') : 'invalid JSON';
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const handleNormalized = body.handle.toLowerCase();
  const sql = getPracticeDb();

  try {
    const result = await sql.begin(async (tx) => {
      // 1. Find or create the lightweight players + player_aliases row for
      //    this platform handle. prep_reports.target_player_id is NOT NULL.
      const existingAlias = await tx<{ player_id: string }[]>`
        SELECT player_id::text FROM player_aliases
        WHERE platform = ${body.platform} AND LOWER(handle) = ${handleNormalized}
        LIMIT 1
      `;

      let targetPlayerId: string;
      if (existingAlias.length > 0) {
        targetPlayerId = existingAlias[0]!.player_id;
      } else {
        const newPlayer = await tx<{ id: string }[]>`
          INSERT INTO players (canonical_name)
          VALUES (${body.handle})
          RETURNING id::text
        `;
        targetPlayerId = newPlayer[0]!.id;
        await tx`
          INSERT INTO player_aliases (player_id, platform, handle, source)
          VALUES (${targetPlayerId}::uuid, ${body.platform}, ${body.handle}, 'inferred')
          ON CONFLICT (platform, handle) DO NOTHING
        `;
      }

      // 2. Idempotent report creation. The partial unique index
      //    prep_reports_active_per_opp guarantees one row per opponent.
      //    If the existing row is in a terminal 'failed' state, reset it
      //    so the user can retry (the failure reason may have been
      //    no_linked_accounts or opponent_not_in_corpus, both fixable).
      const existingReport = await tx<{ id: string; status: string }[]>`
        SELECT id::text, status FROM prep_reports
        WHERE requested_by = ${user.id}::uuid
          AND target_platform = ${body.platform}
          AND target_handle_normalized = ${handleNormalized}
        LIMIT 1
      `;
      if (existingReport.length > 0) {
        const existing = existingReport[0]!;
        if (existing.status === 'failed') {
          await tx`
            UPDATE prep_reports
            SET status = 'data_pending',
                error_text = NULL,
                leaks_json = NULL,
                completed_at = NULL
            WHERE id = ${existing.id}::uuid
          `;
          return { id: existing.id, status: 'data_pending' as const, reused: true };
        }
        return { id: existing.id, status: existing.status, reused: true };
      }

      const inserted = await tx<{ id: string }[]>`
        INSERT INTO prep_reports (
          requested_by, target_player_id, target_platform, target_handle_normalized, status
        ) VALUES (
          ${user.id}::uuid, ${targetPlayerId}::uuid, ${body.platform}, ${handleNormalized},
          'data_pending'
        )
        RETURNING id::text
      `;
      return { id: inserted[0]!.id, status: 'data_pending' as const, reused: false };
    });

    return NextResponse.json(result, { status: result.reused ? 200 : 201 });
  } catch (err) {
    console.error('[POST /api/prepare/reports] failed:', err);
    return NextResponse.json({ error: 'failed_to_create_report' }, { status: 500 });
  }
}
