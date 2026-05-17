/**
 * GET /api/account/export — GDPR Article 15 data export.
 *
 * Bundles the caller's profile + linked accounts + ratings + practice
 * preferences + challenges + matches + ledger entries + refund requests
 * into one JSON document. Each per-table query is row-capped to keep the
 * response build in-memory and bounded; if a cap fires the response
 * payload's `truncated[<dataset>]` flag is set true so the user (and
 * GDPR Art. 15 auditor) knows to follow up with a manual export.
 *
 * Rate limit: 1 export per profile per 24h (enforced by checking the most
 * recent audit_logs row for action='account.export'). Spec §24.
 */
import { NextResponse } from 'next/server';
import { getUser } from '@/lib/auth';
import { getPracticeDb } from '@/lib/practice/db';

const RATE_LIMIT_HOURS = 24;
// Caps chosen to bound JSON.stringify memory; an entry with ~500 bytes
// avg gives ~25 MB per dataset at the cap. Users hitting any cap are
// flagged in the response and routed to support per GDPR runbook.
const ROW_CAP = 50_000;
const MATCHES_CAP = 10_000;

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
    sql`SELECT * FROM external_accounts WHERE profile_id = ${user.id}::uuid LIMIT ${ROW_CAP + 1}`,
    sql`SELECT * FROM ratings WHERE profile_id = ${user.id}::uuid LIMIT ${ROW_CAP + 1}`,
    sql`SELECT * FROM user_practice_prefs WHERE profile_id = ${user.id}::uuid LIMIT ${ROW_CAP + 1}`,
    sql`SELECT * FROM challenges WHERE creator_id = ${user.id}::uuid ORDER BY created_at DESC LIMIT ${ROW_CAP + 1}`,
    sql`SELECT * FROM matches WHERE creator_id = ${user.id}::uuid OR opponent_id = ${user.id}::uuid ORDER BY created_at DESC LIMIT ${MATCHES_CAP + 1}`,
    sql`SELECT * FROM ledger_entries WHERE account_type = 'user_wallet' AND account_id = ${user.id}::uuid ORDER BY created_at DESC LIMIT ${ROW_CAP + 1}`,
    sql`SELECT * FROM refund_requests WHERE requester_id = ${user.id}::uuid OR respondent_id = ${user.id}::uuid ORDER BY created_at DESC LIMIT ${ROW_CAP + 1}`,
  ]);

  // capN(rows, n) → { rows, truncated }: trim the over-fetched sentinel
  // row and report whether the cap actually fired.
  const cap = <T>(rows: readonly T[], n: number): { rows: T[]; truncated: boolean } =>
    rows.length > n
      ? { rows: rows.slice(0, n), truncated: true }
      : { rows: [...rows], truncated: false };

  const externalAccountsCapped = cap(externalAccounts, ROW_CAP);
  const ratingsCapped = cap(ratings, ROW_CAP);
  const prefsCapped = cap(prefs, ROW_CAP);
  const challengesCapped = cap(challenges, ROW_CAP);
  const matchesCapped = cap(matches, MATCHES_CAP);
  const ledgerCapped = cap(ledgerEntries, ROW_CAP);
  const refundsCapped = cap(refundRequests, ROW_CAP);

  await sql`
    INSERT INTO audit_logs (actor_type, actor_id, action, target_type, target_id)
    VALUES ('user', ${user.id}::uuid, 'account.export', 'profile', ${user.id})
  `;

  const truncated = {
    external_accounts: externalAccountsCapped.truncated,
    ratings: ratingsCapped.truncated,
    practice_prefs: prefsCapped.truncated,
    challenges: challengesCapped.truncated,
    matches: matchesCapped.truncated,
    ledger_entries: ledgerCapped.truncated,
    refund_requests: refundsCapped.truncated,
  };
  const anyTruncated = Object.values(truncated).some(Boolean);

  const payload = {
    generated_at: new Date().toISOString(),
    caps: { row_cap: ROW_CAP, matches_cap: MATCHES_CAP },
    truncated,
    any_truncated: anyTruncated,
    follow_up: anyTruncated
      ? 'Some datasets exceeded the per-table cap. Email support to receive a full manual export per GDPR Art. 15.'
      : null,
    profile,
    external_accounts: externalAccountsCapped.rows,
    ratings: ratingsCapped.rows,
    practice_prefs: prefsCapped.rows,
    challenges: challengesCapped.rows,
    matches: matchesCapped.rows,
    ledger_entries: ledgerCapped.rows,
    refund_requests: refundsCapped.rows,
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
