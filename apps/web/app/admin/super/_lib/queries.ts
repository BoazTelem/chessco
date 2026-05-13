import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { rangeStartISO, type Range } from './range';

// Wrapper so individual pages share one admin client per render.
export function adminDb() {
  return createAdminClient();
}

// ---- Aggregate counts -------------------------------------------------------

export async function countRowsSince(table: string, column: string, range: Range): Promise<number> {
  const sb = adminDb();
  const start = rangeStartISO(range);
  let q = sb.from(table).select('*', { count: 'exact', head: true });
  if (start) q = q.gte(column, start);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

export async function countDistinctActiveUsers(range: Range): Promise<number> {
  const sb = adminDb();
  const start = rangeStartISO(range);
  let q = sb.from('profiles').select('id', { count: 'exact', head: true });
  if (start) q = q.gte('last_seen_at', start);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

// ---- Daily series builders --------------------------------------------------

export type DailySeries = { date: string; count: number }[];

// Builds a dense daily series (zero-filling missing days) for a date column.
export async function dailyCount(
  table: string,
  column: string,
  range: Range,
): Promise<DailySeries> {
  const sb = adminDb();
  const start = rangeStartISO(range);
  const startDate = start ? new Date(start) : null;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  let q = sb.from(table).select(column);
  if (start) q = q.gte(column, start);
  const { data, error } = await q;
  if (error) throw error;

  const buckets = new Map<string, number>();
  for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
    const v = row[column];
    if (!v || typeof v !== 'string') continue;
    const d = new Date(v);
    const k = d.toISOString().slice(0, 10);
    buckets.set(k, (buckets.get(k) ?? 0) + 1);
  }

  const firstDate = startDate ?? earliestKey(buckets) ?? today;
  firstDate.setUTCHours(0, 0, 0, 0);

  const result: DailySeries = [];
  for (let d = new Date(firstDate); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    const k = d.toISOString().slice(0, 10);
    result.push({ date: k.slice(5), count: buckets.get(k) ?? 0 });
  }
  return result;
}

function earliestKey(buckets: Map<string, number>): Date | null {
  let min: string | null = null;
  for (const k of buckets.keys()) {
    if (!min || k < min) min = k;
  }
  return min ? new Date(min) : null;
}

// ---- Revenue (deposit-side fee model) --------------------------------------

export async function sumLedger(
  category: string,
  accountType: string,
  range: Range,
): Promise<number> {
  const sb = adminDb();
  const start = rangeStartISO(range);
  let q = sb
    .from('ledger_entries')
    .select('amount_cents')
    .eq('category', category)
    .eq('account_type', accountType);
  if (start) q = q.gte('created_at', start);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).reduce((acc, r) => acc + (r.amount_cents ?? 0), 0);
}

export async function totalWalletLiability(): Promise<number> {
  const sb = adminDb();
  const { data, error } = await sb.from('wallets').select('available_cents,pending_cents');
  if (error) throw error;
  return (data ?? []).reduce(
    (acc, r) => acc + (r.available_cents ?? 0) + (r.pending_cents ?? 0),
    0,
  );
}

// ---- Funnel ----------------------------------------------------------------

export type FunnelStage = { label: string; count: number };

export async function funnel(range: Range): Promise<FunnelStage[]> {
  const sb = adminDb();
  const start = rangeStartISO(range);

  // 1. Signups
  let signupQ = sb.from('profiles').select('id', { count: 'exact', head: true });
  if (start) signupQ = signupQ.gte('created_at', start);
  const { count: signups } = await signupQ;

  // 2. Linked at least one external account
  const { data: linked } = await sb.from('external_accounts').select('profile_id');
  const linkedIds = new Set((linked ?? []).map((r) => r.profile_id));

  // 3. Ran at least one search
  const { data: searched } = await sb.from('identification_queries').select('requested_by');
  const searchedIds = new Set((searched ?? []).map((r) => r.requested_by));

  // 4. Ran at least one prep report
  const { data: prepped } = await sb.from('prep_reports').select('requested_by');
  const preppedIds = new Set((prepped ?? []).map((r) => r.requested_by));

  // 5. Succeeded at least one topup
  // topup_intents may not exist if migration not yet applied — guard.
  let topupperIds = new Set<string>();
  try {
    const { data: topups } = await sb
      .from('topup_intents')
      .select('profile_id')
      .eq('status', 'succeeded');
    topupperIds = new Set((topups ?? []).map((r) => r.profile_id));
  } catch {
    // table not yet present; leave empty
  }

  // 6. Played at least one paid match (as creator or opponent)
  const { data: opponents } = await sb.from('matches').select('opponent_id');
  const { data: challenges } = await sb.from('challenges').select('creator_id,status');
  const playedIds = new Set<string>();
  for (const r of opponents ?? []) playedIds.add(r.opponent_id);
  for (const r of challenges ?? []) if (r.status !== 'open') playedIds.add(r.creator_id);

  return [
    { label: 'Signed up', count: signups ?? 0 },
    { label: 'Linked chess account', count: linkedIds.size },
    { label: 'Ran a search', count: searchedIds.size },
    { label: 'Built a prep report', count: preppedIds.size },
    { label: 'Topped up wallet', count: topupperIds.size },
    { label: 'Played a paid match', count: playedIds.size },
  ];
}
