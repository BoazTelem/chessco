/**
 * GET /api/prepare/reports/[id] — status + locked/unlocked leak DTOs.
 *
 * Behavior:
 *   - 'pending' / 'data_pending' / 'building': returns status (+ substage
 *     derived from corpus state so the UI can show a more specific message
 *     than "indexing").
 *   - 'failed': returns status + error_text.
 *   - 'ready': if leaks_json is null, compute on demand from the games
 *     corpus and persist it on the row (one-time cost per report). Also
 *     auto-unlocks the top-scoring 'personalized' leak as the user's free
 *     pick — uses the existing prep_leak_unlocks_one_free_per_opp partial
 *     unique index so it's idempotent. Then returns leaks with
 *     per-fingerprint locked/unlocked flags.
 *
 * Locked leak DTOs omit board/sanPath/recommended-move detail (just opening
 * name + game count). Unlocked leaks include the full detail. Surprise lines
 * are always returned with full detail (they are free).
 */
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getPracticeDb } from '@/lib/practice/db';
import { computeReportLeaks } from '@/lib/leaks/compute';
import { repertoireReadiness, getGamesDb } from '@/lib/leaks/readiness';
import type { Leak, Platform } from '@/lib/leaks/types';

interface ReportRow {
  id: string;
  status: string;
  requested_by: string;
  target_platform: Platform | null;
  target_handle_normalized: string | null;
  leaks_json: { white: Leak[]; black: Leak[]; generated_at: string } | null;
  error_text: string | null;
}

interface UnlockRow {
  leak_fingerprint: string;
}

type Substage =
  | 'awaiting_games'
  | 'building_repertoire'
  | 'awaiting_user_handle'
  | 'engine_evaluating';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { id } = await ctx.params;
  const sql = getPracticeDb();

  const rows = await sql<ReportRow[]>`
    SELECT id::text, status, requested_by::text,
           target_platform, target_handle_normalized,
           leaks_json, error_text
    FROM prep_reports
    WHERE id = ${id}::uuid
    LIMIT 1
  `;
  const report = rows[0];
  if (!report) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (report.requested_by !== user.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  if (report.status === 'pending' || report.status === 'data_pending') {
    const substage =
      report.target_platform && report.target_handle_normalized
        ? await deriveSubstage(
            sql,
            user.id,
            report.target_platform,
            report.target_handle_normalized,
          )
        : null;
    return NextResponse.json({ status: report.status, substage });
  }
  if (report.status === 'building') {
    return NextResponse.json({ status: report.status, substage: 'engine_evaluating' as const });
  }
  if (report.status === 'failed') {
    return NextResponse.json({ status: 'failed', error: report.error_text });
  }
  if (report.status !== 'ready') {
    return NextResponse.json({ status: report.status });
  }

  if (!report.target_platform || !report.target_handle_normalized) {
    return NextResponse.json({ error: 'invalid_report_state' }, { status: 500 });
  }

  // Compute leaks on first read for a ready report. On any compute error,
  // persist an empty payload so the frontend stops polling — better UX than
  // an infinite "Preparing your report…" spinner on a transient 500.
  let leaks = report.leaks_json;
  if (!leaks) {
    try {
      leaks = await computeReportLeaks({
        profileId: user.id,
        targetPlatform: report.target_platform,
        targetHandleNormalized: report.target_handle_normalized,
      });
    } catch (err) {
      console.error('[GET /api/prepare/reports/:id] compute failed:', err);
      leaks = { white: [], black: [], generated_at: new Date().toISOString() };
    }
    try {
      await sql`
        UPDATE prep_reports
        SET leaks_json = ${JSON.stringify(leaks)}::jsonb
        WHERE id = ${id}::uuid
      `;
    } catch (writeErr) {
      console.error('[GET /api/prepare/reports/:id] persist leaks failed:', writeErr);
    }
  }

  // Auto-unlock the top personalized leak so the user always sees one full
  // leak without spending a credit. Skip if any unlock row already exists
  // for this opponent — the user's free slot may belong to a leak they
  // actively revealed, and prep_leak_unlocks_one_free_per_opp limits us
  // to a single cost_credits=0 row anyway.
  await autoUnlockTopLeak({
    sql,
    profileId: user.id,
    platform: report.target_platform,
    handleNormalized: report.target_handle_normalized,
    prepReportId: id,
    leaks,
  });

  // Query unlocks AFTER the auto-unlock so the freebie shows up immediately.
  const unlocks = await sql<UnlockRow[]>`
    SELECT leak_fingerprint FROM prep_leak_unlocks
    WHERE profile_id = ${user.id}::uuid
      AND target_platform = ${report.target_platform}
      AND target_handle_normalized = ${report.target_handle_normalized}
  `;
  const unlockedFingerprints = new Set(unlocks.map((u) => u.leak_fingerprint));

  const dto = (leak: Leak) => {
    // 'surprise' and 'own' leaks are free to view; only 'personalized'
    // (opponent's blunder you can punish) gates behind credits.
    const isUnlocked =
      leak.kind === 'surprise' || leak.kind === 'own' || unlockedFingerprints.has(leak.fingerprint);
    if (isUnlocked) {
      return { ...leak, locked: false as const };
    }
    return {
      fingerprint: leak.fingerprint,
      kind: leak.kind,
      locked: true as const,
      stats: {
        gamesCount: leak.stats.gamesCount,
        userReach: leak.stats.userReach,
        opponentReach: leak.stats.opponentReach,
      },
    };
  };

  return NextResponse.json({
    status: 'ready',
    generated_at: leaks.generated_at,
    leaks: {
      white: leaks.white.map(dto),
      black: leaks.black.map(dto),
    },
  });
}

/**
 * Inspect the games corpus to figure out what stage the poller is stuck on,
 * so the UI can show a specific message ("Waiting for games…" vs "Building
 * opponent repertoire…") instead of one generic "Indexing" copy.
 *
 * We trade one extra games-DB roundtrip per poll for not adding a column to
 * prep_reports — substage is a derived, transient hint, not durable state.
 */
async function deriveSubstage(
  practice: ReturnType<typeof getPracticeDb>,
  profileId: string,
  platform: Platform,
  handleNormalized: string,
): Promise<Substage | null> {
  try {
    const games = getGamesDb();
    const rows = (await games`
      SELECT 1 FROM handles
      WHERE platform = ${platform} AND LOWER(handle) = ${handleNormalized}
      LIMIT 1
    `) as Array<{ '?column?': number }>;
    if (rows.length === 0) {
      return 'awaiting_games';
    }
    const readiness = await repertoireReadiness({ platform, handleNormalized });
    if (!readiness.white || !readiness.black) {
      return 'building_repertoire';
    }

    const linked = await practice<{ platform: Platform; external_id: string }[]>`
      SELECT platform, external_id
      FROM external_accounts
      WHERE profile_id = ${profileId}::uuid
        AND platform IN ('lichess', 'chess.com')
        AND verified = true
    `;
    if (linked.length === 0) return 'awaiting_user_handle';

    for (const acc of linked) {
      const userHandle = acc.external_id.trim().toLowerCase();
      const userRows = (await games`
        SELECT 1 FROM handles
        WHERE platform = ${acc.platform} AND LOWER(handle) = ${userHandle}
        LIMIT 1
      `) as Array<{ '?column?': number }>;
      if (userRows.length === 0) return 'awaiting_user_handle';

      const userReadiness = await repertoireReadiness({
        platform: acc.platform,
        handleNormalized: userHandle,
      });
      if (!userReadiness.white || !userReadiness.black) return 'building_repertoire';
    }

    return 'engine_evaluating';
  } catch (err) {
    console.warn('[deriveSubstage] games-DB lookup failed:', err);
    return null;
  }
}

async function autoUnlockTopLeak(args: {
  sql: ReturnType<typeof getPracticeDb>;
  profileId: string;
  platform: Platform;
  handleNormalized: string;
  prepReportId: string;
  leaks: { white: Leak[]; black: Leak[]; generated_at: string };
}): Promise<void> {
  const { sql, profileId, platform, handleNormalized, prepReportId, leaks } = args;
  try {
    await sql.begin(async (tx) => {
      // Serialize with the manual reveal endpoint, which uses the same lock
      // before deciding whether the first unlock is free or paid.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${profileId})::bigint)`;

      // Skip if the user already has any unlock for this opponent; their free
      // slot may belong to a leak they actively revealed.
      const existing = await tx<{ leak_fingerprint: string }[]>`
        SELECT leak_fingerprint FROM prep_leak_unlocks
        WHERE profile_id = ${profileId}::uuid
          AND target_platform = ${platform}
          AND target_handle_normalized = ${handleNormalized}
        LIMIT 1
      `;
      if (existing.length > 0) return;

      // Combine both colors and pick the highest-scoring `personalized` leak.
      // 'own' / 'surprise' are already unlocked downstream; only `personalized`
      // is gated, so unlocking one of those is what gives the user something.
      const combined = [...leaks.white, ...leaks.black]
        .filter((l) => l.kind === 'personalized')
        .sort((a, b) => b.score - a.score);
      const top = combined[0];
      if (!top) return;

      await tx`
        INSERT INTO prep_leak_unlocks
          (
            profile_id,
            target_platform,
            target_handle_normalized,
            leak_fingerprint,
            prep_report_id,
            cost_credits
          )
        VALUES (
          ${profileId}::uuid,
          ${platform},
          ${handleNormalized},
          ${top.fingerprint},
          ${prepReportId}::uuid,
          0
        )
        ON CONFLICT DO NOTHING
      `;
    });
  } catch (err) {
    console.warn('[autoUnlockTopLeak] failed (non-fatal):', err);
  }
}
