/**
 * Provider-agnostic transactional email send. Spec §21.
 *
 * Default provider is Resend (REST API). The transport is replaceable via
 * setEmailTransport() — useful for tests + future provider swaps. Without
 * a configured transport (no RESEND_API_KEY), sendEmail() resolves with
 * { delivered: false, reason: 'transport_unconfigured' } so callers don't
 * crash; the route logs and continues.
 */
import { renderEmail, type EmailTemplateId, type TemplateInputs } from './templates';

export interface EmailTransport {
  send: (args: {
    to: string;
    from: string;
    subject: string;
    text: string;
    html: string;
  }) => Promise<{ id: string }>;
}

export interface SendResult {
  delivered: boolean;
  providerId?: string;
  reason?: 'transport_unconfigured' | 'transport_error';
  error?: string;
}

let transport: EmailTransport | null = null;

export function setEmailTransport(t: EmailTransport | null): void {
  transport = t;
}

function defaultFrom(): string {
  return process.env.EMAIL_FROM ?? 'Chessco <no-reply@chessco.org>';
}

function getResendTransport(): EmailTransport | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  return {
    async send(args) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          to: [args.to],
          from: args.from,
          subject: args.subject,
          text: args.text,
          html: args.html,
        }),
      });
      if (!res.ok) {
        throw new Error(`resend HTTP ${res.status}`);
      }
      const data = (await res.json()) as { id: string };
      return { id: data.id };
    },
  };
}

function resolveTransport(): EmailTransport | null {
  if (transport) return transport;
  const resend = getResendTransport();
  if (resend) {
    transport = resend;
    return resend;
  }
  return null;
}

export async function sendEmail<K extends EmailTemplateId>(args: {
  to: string;
  template: K;
  input: TemplateInputs[K];
  from?: string;
}): Promise<SendResult> {
  const t = resolveTransport();
  if (!t) {
    return { delivered: false, reason: 'transport_unconfigured' };
  }
  const rendered = renderEmail(args.template, args.input);
  try {
    const sent = await t.send({
      to: args.to,
      from: args.from ?? defaultFrom(),
      ...rendered,
    });
    return { delivered: true, providerId: sent.id };
  } catch (err) {
    return {
      delivered: false,
      reason: 'transport_error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export { renderEmail };
export type { EmailTemplateId, TemplateInputs };
