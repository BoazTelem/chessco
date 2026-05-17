/**
 * Transactional email template registry. Spec §21.
 *
 * Each template is a pure renderer that takes typed inputs and returns
 * { subject, text, html }. The send transport (apps/web/lib/email/index.ts)
 * picks the template by id and routes through the configured provider
 * (Resend by default; swappable).
 *
 * Templates ARE NOT internationalized yet — Phase 7+. Strings are EN-US.
 */

export type EmailTemplateId =
  | 'verify_email'
  | 'magic_link'
  | 'prep_report_ready'
  | 'challenge_accepted'
  | 'match_settled'
  | 'refund_decided'
  | 'fairplay_action'
  | 'ban_applied'
  | 'ban_lifted'
  | 'mod_warning'
  | 'referral_credited';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface TemplateInputs {
  verify_email: { displayName: string | null; verifyUrl: string };
  magic_link: { displayName: string | null; loginUrl: string };
  prep_report_ready: { displayName: string | null; reportUrl: string; opponentLabel: string };
  challenge_accepted: { displayName: string | null; challengeUrl: string; opponentLabel: string };
  match_settled: {
    displayName: string | null;
    matchUrl: string;
    payoutCents: number;
    currency: string;
    result: '1-0' | '0-1' | '1/2-1/2';
  };
  refund_decided: {
    displayName: string | null;
    matchUrl: string;
    decision: 'auto_approved' | 'approved' | 'denied';
    notes: string | null;
  };
  fairplay_action: {
    displayName: string | null;
    action: 'warning' | 'paid_play_suspended' | 'banned';
    appealUrl: string;
  };
  ban_applied: {
    displayName: string | null;
    reason: string;
    appealUrl: string;
  };
  ban_lifted: {
    displayName: string | null;
    signInUrl: string;
  };
  mod_warning: {
    displayName: string | null;
    reason: string;
    inboxUrl: string;
  };
  referral_credited: {
    displayName: string | null;
    refereeLabel: string;
    amount: number;
    walletUrl: string;
  };
}

function shell(title: string, body: string): string {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">',
    `<title>${title}</title></head>`,
    '<body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#0F172A;background:#fff;padding:24px;max-width:560px;margin:0 auto;">',
    body,
    '<hr style="border:none;border-top:1px solid #e2e8f0;margin-top:32px;margin-bottom:16px;">',
    '<p style="color:#64748b;font-size:12px;">Chessco · chessco.org</p>',
    '</body></html>',
  ].join('\n');
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function greeting(name: string | null): string {
  return name ? `Hi ${name},` : 'Hi,';
}

function formatCents(c: number, currency: string): string {
  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : `${currency} `;
  return `${symbol}${(c / 100).toFixed(2)}`;
}

export function renderEmail<K extends EmailTemplateId>(
  id: K,
  input: TemplateInputs[K],
): RenderedEmail {
  switch (id) {
    case 'verify_email': {
      const i = input as TemplateInputs['verify_email'];
      const text = `${greeting(i.displayName)}\n\nConfirm your email by opening this link:\n${i.verifyUrl}\n\nIf you didn't sign up, ignore this email.`;
      const html = shell(
        'Confirm your email',
        `<p>${greeting(i.displayName)}</p><p>Confirm your email by clicking the button below.</p><p><a href="${escapeHtml(i.verifyUrl)}" style="display:inline-block;background:#EAB308;color:#0F172A;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600;">Confirm email</a></p><p style="color:#64748b;font-size:12px;">If you didn't sign up, ignore this email.</p>`,
      );
      return { subject: 'Confirm your Chessco email', text, html };
    }
    case 'magic_link': {
      const i = input as TemplateInputs['magic_link'];
      const text = `${greeting(i.displayName)}\n\nClick this link to sign in:\n${i.loginUrl}\n\nThe link is valid for 10 minutes.`;
      const html = shell(
        'Sign in to Chessco',
        `<p>${greeting(i.displayName)}</p><p>Click the button to sign in. The link expires in 10 minutes.</p><p><a href="${escapeHtml(i.loginUrl)}" style="display:inline-block;background:#EAB308;color:#0F172A;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600;">Sign in</a></p>`,
      );
      return { subject: 'Sign in to Chessco', text, html };
    }
    case 'prep_report_ready': {
      const i = input as TemplateInputs['prep_report_ready'];
      const text = `${greeting(i.displayName)}\n\nYour prep report for ${i.opponentLabel} is ready:\n${i.reportUrl}`;
      const html = shell(
        'Prep report ready',
        `<p>${greeting(i.displayName)}</p><p>Your prep report for <strong>${escapeHtml(i.opponentLabel)}</strong> is ready.</p><p><a href="${escapeHtml(i.reportUrl)}">Open the report</a></p>`,
      );
      return { subject: `Prep report ready: ${i.opponentLabel}`, text, html };
    }
    case 'challenge_accepted': {
      const i = input as TemplateInputs['challenge_accepted'];
      const text = `${greeting(i.displayName)}\n\n${i.opponentLabel} accepted your challenge.\nOpen the game: ${i.challengeUrl}`;
      const html = shell(
        'Challenge accepted',
        `<p>${greeting(i.displayName)}</p><p><strong>${escapeHtml(i.opponentLabel)}</strong> accepted your challenge.</p><p><a href="${escapeHtml(i.challengeUrl)}">Open the game</a></p>`,
      );
      return { subject: 'Your challenge was accepted', text, html };
    }
    case 'match_settled': {
      const i = input as TemplateInputs['match_settled'];
      const payout = formatCents(i.payoutCents, i.currency);
      const text = `${greeting(i.displayName)}\n\nMatch settled (${i.result}). Payout: ${payout}.\n${i.matchUrl}`;
      const html = shell(
        'Match settled',
        `<p>${greeting(i.displayName)}</p><p>Match settled (${i.result}). Payout: <strong>${payout}</strong>.</p><p><a href="${escapeHtml(i.matchUrl)}">Open the post-game review</a></p>`,
      );
      return { subject: 'Match settled', text, html };
    }
    case 'refund_decided': {
      const i = input as TemplateInputs['refund_decided'];
      const verdict = i.decision === 'auto_approved' ? 'approved automatically' : i.decision;
      const text = `${greeting(i.displayName)}\n\nYour refund was ${verdict}.\n${i.notes ?? ''}\n${i.matchUrl}`;
      const html = shell(
        'Refund decided',
        `<p>${greeting(i.displayName)}</p><p>Your refund was <strong>${escapeHtml(verdict)}</strong>.</p>${i.notes ? `<p>${escapeHtml(i.notes)}</p>` : ''}<p><a href="${escapeHtml(i.matchUrl)}">View match</a></p>`,
      );
      return { subject: `Refund ${verdict}`, text, html };
    }
    case 'fairplay_action': {
      const i = input as TemplateInputs['fairplay_action'];
      const text = `${greeting(i.displayName)}\n\nA fairplay action has been recorded on your account: ${i.action}.\nAppeal: ${i.appealUrl}`;
      const html = shell(
        'Fairplay action',
        `<p>${greeting(i.displayName)}</p><p>A fairplay action has been recorded on your account: <strong>${i.action}</strong>.</p><p>If you believe this is in error, you can <a href="${escapeHtml(i.appealUrl)}">appeal</a>.</p>`,
      );
      return { subject: 'Fairplay action recorded', text, html };
    }
    case 'ban_applied': {
      const i = input as TemplateInputs['ban_applied'];
      const text = `${greeting(i.displayName)}\n\nYour Chessco account has been suspended.\n\nReason: ${i.reason}\n\nIf you believe this is in error, you can appeal: ${i.appealUrl}`;
      const html = shell(
        'Account suspended',
        `<p>${greeting(i.displayName)}</p><p>Your Chessco account has been suspended.</p><p><strong>Reason:</strong> ${escapeHtml(i.reason)}</p><p>If you believe this is in error, you can <a href="${escapeHtml(i.appealUrl)}">appeal</a>.</p>`,
      );
      return { subject: 'Your Chessco account has been suspended', text, html };
    }
    case 'ban_lifted': {
      const i = input as TemplateInputs['ban_lifted'];
      const text = `${greeting(i.displayName)}\n\nYour Chessco account has been reinstated. You can sign back in: ${i.signInUrl}`;
      const html = shell(
        'Account reinstated',
        `<p>${greeting(i.displayName)}</p><p>Your Chessco account has been reinstated. You can <a href="${escapeHtml(i.signInUrl)}">sign back in</a>.</p>`,
      );
      return { subject: 'Your Chessco account has been reinstated', text, html };
    }
    case 'mod_warning': {
      const i = input as TemplateInputs['mod_warning'];
      const text = `${greeting(i.displayName)}\n\nA moderator has issued a warning on your account.\n\nReason: ${i.reason}\n\nReview your inbox: ${i.inboxUrl}\n\nFurther violations may result in suspension.`;
      const html = shell(
        'Moderator warning',
        `<p>${greeting(i.displayName)}</p><p>A moderator has issued a warning on your account.</p><p><strong>Reason:</strong> ${escapeHtml(i.reason)}</p><p>Further violations may result in suspension. <a href="${escapeHtml(i.inboxUrl)}">Review your inbox</a>.</p>`,
      );
      return { subject: 'Moderator warning on your Chessco account', text, html };
    }
    case 'referral_credited': {
      const i = input as TemplateInputs['referral_credited'];
      const text = `${greeting(i.displayName)}\n\n${i.refereeLabel} joined Chessco using your referral link. You've been credited ${i.amount} credits.\n\nWallet: ${i.walletUrl}`;
      const html = shell(
        'You earned referral credits',
        `<p>${greeting(i.displayName)}</p><p><strong>${escapeHtml(i.refereeLabel)}</strong> joined Chessco using your referral link. You've been credited <strong>${i.amount} credits</strong>.</p><p><a href="${escapeHtml(i.walletUrl)}">Open your wallet</a></p>`,
      );
      return { subject: `You earned ${i.amount} referral credits`, text, html };
    }
  }
  // Exhaustive switch above; this is unreachable but TS doesn't know.
  throw new Error(`unknown email template id`);
}
