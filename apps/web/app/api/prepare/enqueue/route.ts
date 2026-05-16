/**
 * POST /api/prepare/enqueue — promote (platform, handle) to high priority
 * in the crawl queue so the worker pipeline backfills this user's games
 * for our corpus on the next pass.
 *
 * Fired from /prepare/[platform]/[handle] page mount. The page already
 * does a fast live-fetch path for the immediate user experience; this
 * endpoint is the slow-pipeline-side promotion so the corpus catches up
 * for downstream consumers (Stage 3 matcher, Phase 4 correlation engine,
 * Phase 5 LLM rerank) without waiting for the next refresh cron.
 *
 * Priority 100 mirrors the T1 tier used by the seed pipelines
 * (apps/workers/src/chesscom-crawl/queue.ts:seedHandles, the lichess
 * opponent discovery tiering in apps/workers/src/lichess-crawl/
 * discover-opponents.ts).
 *
 * Behavior is monotone: existing rows only get their priority raised,
 * never lowered (GREATEST). A handle already at p100 is a no-op.
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
  const sql = getGamesDb();

  try {
    if (body.platform === 'chess.com') {
      // Upsert the seed-style 'archives_list' row. New handle → worker
      // discovers archives + enqueues archive_month children. Known
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
    } else {
      await sql`
        INSERT INTO lichess_crawl_queue (handle, priority)
        VALUES (${handle}, ${PRIORITY})
        ON CONFLICT (handle) DO UPDATE SET
          priority = GREATEST(lichess_crawl_queue.priority, EXCLUDED.priority)
        WHERE lichess_crawl_queue.priority < EXCLUDED.priority
      `;
    }
  } catch (err) {
    console.error('[prepare/enqueue] failed:', err);
    return NextResponse.json({ error: 'enqueue_failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, priority: PRIORITY }, { status: 200 });
}
