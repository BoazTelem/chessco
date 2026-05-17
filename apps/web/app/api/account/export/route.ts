/**
 * GET /api/account/export — GDPR Article 15 data export.
 *
 * Bundles the caller's profile + linked accounts + ratings + practice
 * preferences + challenges + matches + ledger entries + audit log entries
 * into one JSON document. Streamed as `application/json` with a
 * Content-Disposition attachment header so the browser saves to disk.
 *
 * Rate limit: 1 export per profile per 24h (enforced by checking the most
 * recent audit_logs row for action='account.export'). Spec §24.
 */
import { NextResponse } from 'next/server';
import { getUser } from '@/lib/auth';
import { getPracticeDb } from '@/lib/practice/db';

const RATE_LIMIT_HOURS = 24;

export async function GET(): Promise<NextResponse | Response> {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const sql = getPracticeDb();

  // Rate limit: refuse if a recent export is on the audit log.
  const recentRows = await sql<{ created_at: string }[]>`
    SELECT created_at::text FROM audit_logs
    WHERE actor_id = ${user.id}::uuid
      AND action = 'account.export'
      AND created_at > NOW() - (${RATE_LIMIT_HOURS}::int * INTERVAL '1 hour')
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (recentRows.length > 0) {
    return NextResponse.json(
      {
        error: 'rate_limited',
        message: `One export per ${RATE_LIMIT_HOURS}h. Last export at ${recentRows[0]!.created_at}.`,
      },
      { status: 429 },
    );
  }

  const [
    profile,
    externalAccounts,
    ratings,
    prefs,
    challenges,
    matches,
    ledgerEntries,
    refundRequests,
  ] = await Promise.all([
    sql`SELECT * FROM profiles WHERE id = ${user.id}::uuid`,
    sql`SELECT * FROM external_accounts WHERE profile_id = ${user.id}::uuid`,
    sql`SELECT * FROM ratings WHERE profile_id = ${user.id}::uuid`,
    sql`SELECT * FROM user_practice_prefs WHERE profile_id = ${user.id}::uuid`,
    sql`SELECT * FROM challenges WHERE creator_id = ${user.id}::uuid`,
    sql`SELECT * FROM matches WHERE creator_id = ${user.id}::uuid OR opponent_id = ${user.id}::uuid`,
    sql`SELECT * FROM ledger_entries WHERE account_type = 'user_wallet' AND account_id = ${user.id}::uuid`,
    sql`SELECT * FROM refund_requests WHERE requester_id = ${user.id}::uuid OR respondent_id = ${user.id}::uuid`,
  ]);

  await sql`
    INSERT INTO audit_logs (actor_type, actor_id, action, target_type, target_id)
    VALUES ('user', ${user.id}::uuid, 'account.export', 'profile', ${user.id})
  `;

  const payload = {
    generated_at: new Date().toISOString(),
    profile,
    external_accounts: externalAccounts,
    ratings,
    practice_prefs: prefs,
    challenges,
    matches,
    ledger_entries: ledgerEntries,
    refund_requests: refundRequests,
  };

  const body = JSON.stringify(payload, null, 2);
  const filename = `chessco-export-${user.id.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json`;
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
    },
  });
}
