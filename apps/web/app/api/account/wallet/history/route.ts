/**
 * GET /api/account/wallet/history?cursor=<iso>&limit=N — paginated ledger
 * view for the logged-in caller's user_wallet rows.
 *
 * Default limit 25, max 100. Cursor is the created_at timestamp of the
 * last row from the previous page; pass it back as `cursor` to fetch the
 * next page.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUser } from '@/lib/auth';
import { getPracticeDb } from '@/lib/practice/db';

const Query = z.object({
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export async function GET(req: Request): Promise<NextResponse> {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const url = new URL(req.url);
  let parsed: z.infer<typeof Query>;
  try {
    parsed = Query.parse(Object.fromEntries(url.searchParams));
  } catch (err) {
    const msg =
      err instanceof z.ZodError ? (err.issues[0]?.message ?? 'invalid params') : 'invalid query';
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const limit = parsed.limit ?? 25;
  const sql = getPracticeDb();

  interface Row {
    id: string;
    transaction_id: string;
    direction: string;
    amount_cents: number;
    currency: string;
    category: string;
    reference_type: string | null;
    reference_id: string | null;
    created_at: string;
  }

  const rows = parsed.cursor
    ? await sql<Row[]>`
        SELECT id::text, transaction_id::text, direction, amount_cents,
               currency, category, reference_type, reference_id,
               created_at::text
        FROM ledger_entries
        WHERE account_type = 'user_wallet'
          AND account_id = ${user.id}::uuid
          AND created_at < ${parsed.cursor}::timestamptz
        ORDER BY created_at DESC
        LIMIT ${limit}
      `
    : await sql<Row[]>`
        SELECT id::text, transaction_id::text, direction, amount_cents,
               currency, category, reference_type, reference_id,
               created_at::text
        FROM ledger_entries
        WHERE account_type = 'user_wallet'
          AND account_id = ${user.id}::uuid
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;

  const nextCursor = rows.length === limit ? rows[rows.length - 1]!.created_at : null;
  return NextResponse.json({ rows, next_cursor: nextCursor });
}
