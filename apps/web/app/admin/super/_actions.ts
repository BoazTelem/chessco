'use server';

import { revalidatePath } from 'next/cache';
import { requireSuperAdmin } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';

type ReportResolution = 'resolved_valid' | 'resolved_invalid' | 'duplicate' | 'investigating';
type ReportAction = 'none' | 'warning' | 'ban' | 'payout_forfeit' | 'refund_issued';

export async function resolveReport(formData: FormData) {
  const admin = await requireSuperAdmin();
  const reportId = String(formData.get('report_id') ?? '');
  const status = String(formData.get('status') ?? '') as ReportResolution;
  const actionTaken = String(formData.get('action_taken') ?? 'none') as ReportAction;
  const note = String(formData.get('note') ?? '').trim() || null;

  if (!reportId || !status) throw new Error('report_id and status are required');
  if (!['resolved_valid', 'resolved_invalid', 'duplicate', 'investigating'].includes(status)) {
    throw new Error('invalid status');
  }

  const sb = createAdminClient();

  const { data: report, error: readErr } = await sb
    .from('user_reports')
    .select('id,reported_id,status,action_taken')
    .eq('id', reportId)
    .single();
  if (readErr || !report) throw new Error('report not found');

  const update: Record<string, unknown> = {
    status,
    action_taken: actionTaken,
    resolution_note: note,
    resolved_by: admin.id,
  };
  if (status !== 'investigating') update.resolved_at = new Date().toISOString();
  else update.resolved_at = null;

  const { error: updErr } = await sb.from('user_reports').update(update).eq('id', reportId);
  if (updErr) throw updErr;

  if (actionTaken === 'ban') {
    await sb.from('user_bans').upsert(
      {
        profile_id: report.reported_id,
        banned_by: admin.id,
        reason: note ?? 'Banned via report resolution',
        report_id: reportId,
      },
      { onConflict: 'profile_id' },
    );
  }

  await sb.from('audit_logs').insert({
    actor_type: 'admin',
    actor_id: admin.id,
    action: `report.${status}`,
    target_type: 'user_report',
    target_id: reportId,
    before: { status: report.status, action_taken: report.action_taken },
    after: { status, action_taken: actionTaken },
    reason: note,
  });

  revalidatePath('/admin/super/moderation');
  revalidatePath('/admin/super/users');
}

export async function banUser(formData: FormData) {
  const admin = await requireSuperAdmin();
  const profileId = String(formData.get('profile_id') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (!profileId || !reason) throw new Error('profile_id and reason are required');

  const sb = createAdminClient();
  const { error } = await sb
    .from('user_bans')
    .upsert({ profile_id: profileId, banned_by: admin.id, reason }, { onConflict: 'profile_id' });
  if (error) throw error;

  await sb.from('audit_logs').insert({
    actor_type: 'admin',
    actor_id: admin.id,
    action: 'user.banned',
    target_type: 'profile',
    target_id: profileId,
    reason,
  });

  revalidatePath('/admin/super/moderation');
  revalidatePath('/admin/super/users');
}

export async function liftBan(formData: FormData) {
  const admin = await requireSuperAdmin();
  const profileId = String(formData.get('profile_id') ?? '');
  const reason = String(formData.get('reason') ?? '').trim() || 'No reason given';
  if (!profileId) throw new Error('profile_id is required');

  const sb = createAdminClient();
  const { error } = await sb
    .from('user_bans')
    .update({
      lifted_at: new Date().toISOString(),
      lifted_by: admin.id,
      lifted_reason: reason,
    })
    .eq('profile_id', profileId)
    .is('lifted_at', null);
  if (error) throw error;

  await sb.from('audit_logs').insert({
    actor_type: 'admin',
    actor_id: admin.id,
    action: 'user.ban_lifted',
    target_type: 'profile',
    target_id: profileId,
    reason,
  });

  revalidatePath('/admin/super/moderation');
  revalidatePath('/admin/super/users');
}
