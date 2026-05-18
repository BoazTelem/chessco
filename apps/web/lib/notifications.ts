/**
 * Notification helpers: used by every trigger site (admin moderation actions,
 * fairplay decide route, credit grant helpers, sparring invitation routes).
 *
 * Two entry points, kept separate by design:
 *
 *   createNotification(args, tx?): inserts the row (RLS-protected on read;
 *     clients never insert). Accepts an optional postgres.js transaction so
 *     callers like grantReferralCredits can fold the insert into the same
 *     transaction as the wallet/ledger writes.
 *
 *   sendNotificationEmail(profileId, category, email): best-effort email
 *     dispatch, gated by notification_email_preferences. Always called
 *     OUTSIDE any transaction (i.e. after sql.begin(...) returns) so a
 *     failed Resend call cannot roll back a credit grant.
 *
 * If you need both for an event, call createNotification inside the tx and
 * sendNotificationEmail after the tx returns. For events outside any tx, the
 * order is irrelevant. Call them back-to-back.
 */
import type { Sql, TransactionSql } from 'postgres';
import { getPracticeDb } from '@/lib/practice/db';
import { sendEmail, type EmailTemplateId, type TemplateInputs } from '@/lib/email';

export type NotificationCategory = 'moderation' | 'credits' | 'social';

export type NotificationType =
  | 'ban.applied'
  | 'ban.lifted'
  | 'mod.warning'
  | 'fairplay.warning'
  | 'fairplay.paid_play_suspended'
  | 'fairplay.banned'
  | 'fairplay.dismissed'
  | 'credit.referral_granted'
  | 'credit.link_bonus_granted'
  | 'credit.practice_reward_earned'
  | 'invitation.received'
  | 'invitation.accepted'
  | 'invitation.declined'
  | 'coach.invitation_accepted'
  | 'coach.invitation_ended';

export interface CreateNotificationArgs {
  profileId: string;
  type: NotificationType;
  category: NotificationCategory;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
  actionUrl?: string;
  /**
   * When set, repeated inserts with the same (profileId, type, dedupeKey)
   * collapse via the partial UNIQUE index. data is shallow-merged via jsonb
   * || (incoming keys win), the row is re-surfaced as unread, and
   * created_at is bumped.
   */
  dedupeKey?: string;
}

type SqlLike = Sql<Record<string, never>> | TransactionSql<Record<string, never>>;

export async function createNotification(
  args: CreateNotificationArgs,
  tx?: TransactionSql<Record<string, never>>,
): Promise<void> {
  const sql: SqlLike = tx ?? getPracticeDb();
  const dataJson = JSON.stringify(args.data ?? {});

  if (args.dedupeKey != null) {
    await sql`
      INSERT INTO notifications (
        profile_id, type, category, title, body, data, action_url, dedupe_key
      ) VALUES (
        ${args.profileId}::uuid,
        ${args.type},
        ${args.category},
        ${args.title},
        ${args.body ?? null},
        ${dataJson}::jsonb,
        ${args.actionUrl ?? null},
        ${args.dedupeKey}
      )
      ON CONFLICT (profile_id, type, dedupe_key) WHERE dedupe_key IS NOT NULL
      DO UPDATE SET
        title = EXCLUDED.title,
        body = EXCLUDED.body,
        data = CASE
          WHEN jsonb_typeof(notifications.data->'amount') = 'number'
            AND jsonb_typeof(EXCLUDED.data->'amount') = 'number'
          THEN (notifications.data || EXCLUDED.data) || jsonb_build_object(
            'amount',
            (notifications.data->>'amount')::numeric + (EXCLUDED.data->>'amount')::numeric
          )
          ELSE notifications.data || EXCLUDED.data
        END,
        action_url = EXCLUDED.action_url,
        read_at = NULL,
        created_at = NOW()
    `;
  } else {
    await sql`
      INSERT INTO notifications (
        profile_id, type, category, title, body, data, action_url
      ) VALUES (
        ${args.profileId}::uuid,
        ${args.type},
        ${args.category},
        ${args.title},
        ${args.body ?? null},
        ${dataJson}::jsonb,
        ${args.actionUrl ?? null}
      )
    `;
  }
}

export interface NotificationEmail<K extends EmailTemplateId = EmailTemplateId> {
  template: K;
  input: TemplateInputs[K];
}

/**
 * Send a notification email respecting per-category opt-out. Best-effort,
 * never throws. Callers should invoke this AFTER any wrapping transaction
 * has committed.
 */
export async function sendNotificationEmail(
  profileId: string,
  category: NotificationCategory,
  email: NotificationEmail,
): Promise<void> {
  try {
    const pool = getPracticeDb();

    const prefRows = (await pool`
      SELECT
        moderation_email,
        credits_email,
        social_email
      FROM notification_email_preferences
      WHERE profile_id = ${profileId}::uuid
    `) as Array<{
      moderation_email: boolean;
      credits_email: boolean;
      social_email: boolean;
    }>;

    // Default-on when no row exists.
    const pref = prefRows[0];
    const enabled =
      pref == null
        ? true
        : category === 'moderation'
          ? pref.moderation_email
          : category === 'credits'
            ? pref.credits_email
            : pref.social_email;
    if (!enabled) return;

    const profileRows = (await pool`
      SELECT email, display_name
      FROM profiles
      WHERE id = ${profileId}::uuid
    `) as Array<{ email: string | null; display_name: string | null }>;
    const profile = profileRows[0];
    if (!profile?.email) return;

    await sendEmail({
      to: profile.email,
      template: email.template,
      input: email.input,
    });
  } catch {
    // Email infra is best-effort. Resend transport already logs failures;
    // we don't want to crash a server action because the email side
    // hiccuped.
  }
}

/**
 * Application origin for building absolute URLs in email templates.
 * Falls back to chessco.org per the project's production domain memory.
 */
export function appOrigin(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL ?? 'https://chessco.org';
}
