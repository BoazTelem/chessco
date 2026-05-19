/**
 * POST /api/prepare/enqueue — promote (platform, handle) to high priority
 * in the crawl queue so the worker pipeline backfills this user's games.
 *
 * chess.com: upserts into chesscom_crawl_queue at priority 100; monotone
 * (GREATEST), so a handle already at p100 is a no-op. The Cloud Run
 * crawler picks it up on the next watchdog tick.
 *
 * lichess: NO-OP. Per [docs/INCIDENT-2026-05-18-lichess-ip-block.md], the
 * per-handle /api/games/user/ enumeration is forbidden by Lichess.
 * Lichess corpus updates arrive via the monthly dump pipeline only. The
 * page-mount fetch still surfaces the user's live games client-side; this
 * endpoint just acknowledges the request without queueing.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { getGamesDb } from '@/lib/games-db';

const PRIORITY = 100;

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

  const handle = body.handle.toLowerCase();

  if (body.platform === 'lichess') {
    return NextResponse.json(
      {
        ok: true,
        priority: null,
        note: 'lichess_uses_monthly_dumps',
      },
      { status: 200 },
    );
  }

  const sql = getGamesDb();

  try {
    // chess.com: upsert the seed-style 'archives_list' row. New handle →
    // worker discovers archives + enqueues archive_month children. Known
    // handle → priority bumps on the archives_list row itself; pending
    // archive_month rows (if any) also get promoted to keep the user's
    // backfill ahead of the rest.
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO chesscom_crawl_queue (kind, handle, priority)
        VALUES ('archives_list', ${handle}, ${PRIORITY})
        ON CONFLICT (handle, kind, archive_url) DO UPDATE SET
          priority = GREATEST(chesscom_crawl_queue.priority, EXCLUDED.priority)
        WHERE chesscom_crawl_queue.priority < EXCLUDED.priority
      `;
      await tx`
        UPDATE chesscom_crawl_queue
        SET priority = ${PRIORITY}
        WHERE handle = ${handle}
          AND status IN ('queued', 'failed')
          AND priority < ${PRIORITY}
      `;
    });
  } catch (err) {
    console.error('[prepare/enqueue] failed:', err);
    return NextResponse.json({ error: 'enqueue_failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, priority: PRIORITY }, { status: 200 });
}
